import { supabase } from "@/lib/supabase";
import { paystack } from "@/lib/paystack";
import { NotificationService } from "@/services/notificationService";

export enum DisbursementResult {
  Success = "success",
  PendingOTP = "pending_otp",
  Failed = "failed",
}

export interface DisbursementResponse {
  result: DisbursementResult;
  paystack_transfer_ref?: string;
  recipient_code?: string;
  disbursed_at?: string;
  message?: string;
}

/**
 * Transfer is still moving — wait for the webhook, do not retry with a new
 * reference (Paystack docs: retrying with a new reference double-credits).
 */
const PENDING_TRANSFER_STATUSES = new Set(["pending", "otp", "received"]);

/**
 * Transfer is over and will never complete — safe to record the failure and,
 * on a later retry, start a fresh transfer. Per Paystack's transfer lifecycle.
 */
const FAILED_TRANSFER_STATUSES = new Set([
  "failed",
  "reversed",
  "abandoned",
  "blocked",
  "rejected",
]);

export interface LoanWithProfile {
  id: string;
  member_id: string;
  amount_approved: number;
  interest_rate: number;
  tenure_months: number;
  monthly_repayment: number;
  balance: number;
  status: string;
  /** Reference stored by a previous disbursement attempt, if any. */
  paystack_transfer_ref: string | null;
  /** Paystack transfer_code, needed to finalize OTP-gated transfers. */
  transfer_code: string | null;
  profiles: {
    id: string;
    full_name: string;
    bank_account: string;
    bank_code: string;
    bank_name: string;
  };
}

export async function disburseLoan(loanId: string): Promise<DisbursementResponse> {
  const { data: loan, error: loanError } = await supabase
    .from("loans")
    .select(
      `
      id,
      member_id,
      amount_approved,
      interest_rate,
      tenure_months,
      monthly_repayment,
      balance,
      status,
      paystack_transfer_ref,
      profiles (
        id,
        full_name,
        bank_account,
        bank_code,
        bank_name
      )
    `,
    )
    .eq("id", loanId)
    .single();

  if (loanError || !loan) {
    throw new Error(`Loan not found: ${loanError?.message}`);
  }

  const typedLoan = loan as unknown as LoanWithProfile;
  const member = typedLoan.profiles;

  if (!member.bank_account || !member.bank_code) {
    throw new Error(
      "Member has no bank details on file. Please update profile with bank account.",
    );
  }

  // Retries after a failed disbursement re-enter here once the cause is
  // fixed. Safe: the stored-reference check below makes a retry reconcile
  // instead of duplicating.
  if (!["approved", "disbursement_failed"].includes(typedLoan.status)) {
    throw new Error(
      `Loan must be in approved status to disburse. Current status: ${typedLoan.status}`,
    );
  }

  // Idempotency: a previous attempt may already have a transfer for this
  // loan (stored reference). Per the Paystack docs, a non-conclusive
  // transfer must be retried with the SAME reference — minting a new one
  // while the old transfer is still processing would credit the member
  // twice. So reconcile the stored reference before starting anything new.
  if (typedLoan.paystack_transfer_ref) {
    try {
      const prior = await paystack.verifyTransfer(typedLoan.paystack_transfer_ref);
      if (prior.status === "success") {
        return await completeDisbursement(loanId, typedLoan);
      }
      if (FAILED_TRANSFER_STATUSES.has(prior.status)) {
        return await failDisbursement(
          loanId,
          typedLoan,
          `Prior transfer ended as ${prior.status}`,
        );
      }
      return {
        result: DisbursementResult.PendingOTP,
        paystack_transfer_ref: typedLoan.paystack_transfer_ref,
        message: "Transfer already in progress. Awaiting confirmation via webhook.",
      };
    } catch (err) {
      // Fall through to a fresh transfer ONLY if the stored reference is
      // confirmed unknown to Paystack. Any other verify failure (network,
      // timeout) leaves the prior transfer's state unknown — minting a new
      // transfer then could credit the member twice — so surface the error
      // and keep the loan approved instead.
      const msg = err instanceof Error ? err.message : "";
      if (!/not found/i.test(msg)) {
        throw new Error(
          `Could not confirm the status of the pending transfer (${typedLoan.paystack_transfer_ref}). No new transfer was started: ${msg || "verify unavailable"}`,
        );
      }
    }
  }

  try {
    const verification = await paystack.resolveAccount(member.bank_account, member.bank_code);

    if (verification.account_name) {
      const nameMatch = verification.account_name
        .toLowerCase()
        .includes(member.full_name.toLowerCase());
      if (!nameMatch) {
        console.warn(
          `[Disbursement] Account name mismatch: "${verification.account_name}" vs "${member.full_name}"`,
        );
      }
    }

    const recipient = await paystack.createTransferRecipient({
      name: member.full_name,
      account_number: member.bank_account,
      bank_code: member.bank_code,
    });

    const timestamp = Date.now();
    // Lowercase a-z, 0-9, dash/underscore only, 16–50 chars, per the
    // Transfer API reference.
    const reference = `loan-${loanId.slice(0, 8)}-${timestamp}`;

    const transfer = await paystack.initiateTransfer({
      amount: typedLoan.amount_approved,
      recipient: recipient.recipient_code,
      reference,
      reason: `Loan disbursement for ${member.full_name}`,
    });

    if (transfer.status === "success") {
      await supabase
        .from("loans")
        .update({
          status: "disbursed",
          paystack_transfer_ref: reference,
          recipient_code: recipient.recipient_code,
          transfer_code: transfer.transfer_code,
          disbursed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as any)
        .eq("id", loanId);

      await sendDisbursementSuccessNotification(typedLoan);

      return {
        result: DisbursementResult.Success,
        paystack_transfer_ref: reference,
        recipient_code: recipient.recipient_code,
        disbursed_at: new Date().toISOString(),
        message: "Loan disbursed successfully",
      };
    }

    if (FAILED_TRANSFER_STATUSES.has(transfer.status)) {
      return await failDisbursement(
        loanId,
        typedLoan,
        `Transfer ${transfer.status} at Paystack`,
      );
    }

    // pending / otp / received: the transfer is still moving. Record the
    // reference so retries reconcile instead of duplicating, and leave the
    // loan approved until the webhook confirms.
    await supabase
      .from("loans")
      .update({
        paystack_transfer_ref: reference,
        recipient_code: recipient.recipient_code,
        transfer_code: transfer.transfer_code,
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", loanId);

    return {
      result: DisbursementResult.PendingOTP,
      paystack_transfer_ref: reference,
      recipient_code: recipient.recipient_code,
      message: "Transfer initiated. Awaiting OTP confirmation via webhook.",
    };
  } catch (error) {
    console.error("Disbursement error:", error);

    await supabase
      .from("loans")
      .update({
        status: "disbursement_failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", loanId);

    await sendDisbursementFailedNotification(typedLoan);

    return {
      result: DisbursementResult.Failed,
      message: error instanceof Error ? error.message : "Unknown error during disbursement",
    };
  }
}

/**
 * Finalize an OTP-gated transfer with the code Paystack sent to the
 * business phone. The loan must be `approved` with a stored pending
 * transfer; a wrong OTP does not fail the loan — the transfer stays
 * pending and the admin can retry within Paystack's ~30 minute window.
 */
export async function finalizeDisbursementOtp(
  loanId: string,
  otp: string,
): Promise<DisbursementResponse> {
  const { data: loan, error: loanError } = await supabase
    .from("loans")
    .select(
      `
      id,
      member_id,
      amount_approved,
      interest_rate,
      tenure_months,
      monthly_repayment,
      balance,
      status,
      paystack_transfer_ref,
      transfer_code,
      profiles (
        id,
        full_name,
        bank_account,
        bank_code,
        bank_name
      )
    `,
    )
    .eq("id", loanId)
    .single();

  if (loanError || !loan) {
    throw new Error("Loan not found");
  }

  const typedLoan = loan as unknown as LoanWithProfile;

  if (typedLoan.status !== "approved") {
    throw new Error(
      `Only a loan awaiting disbursement can be finalized. Current status: ${typedLoan.status}`,
    );
  }
  if (!typedLoan.paystack_transfer_ref) {
    throw new Error("No pending transfer for this loan. Disburse first.");
  }

  // Older pending transfers predate the transfer_code column — recover the
  // code via Verify (which returns it) and persist it for next time.
  let transferCode = typedLoan.transfer_code;
  if (!transferCode) {
    const current = await paystack.verifyTransfer(typedLoan.paystack_transfer_ref);
    if (current.status === "success") {
      return await completeDisbursement(loanId, typedLoan);
    }
    if (FAILED_TRANSFER_STATUSES.has(current.status)) {
      return await failDisbursement(
        loanId,
        typedLoan,
        `Prior transfer ended as ${current.status}`,
      );
    }
    transferCode = current.transfer_code;
    await supabase
      .from("loans")
      .update({ transfer_code: transferCode } as any)
      .eq("id", loanId);
  }

  let finalized;
  try {
    finalized = await paystack.finalizeTransfer({ transfer_code: transferCode, otp });
  } catch (err) {
    // A rejected OTP (or finalize outage) is not a failed transfer — check
    // the transfer's actual state before deciding.
    const msg = err instanceof Error ? err.message : "OTP not accepted";
    const current = await paystack
      .verifyTransfer(typedLoan.paystack_transfer_ref)
      .catch(() => null);
    console.error(
      `[Disbursement] Finalize rejected for loan ${loanId} (ref ${typedLoan.paystack_transfer_ref}, code ${transferCode}): ${msg}. Live status: ${current?.status ?? "unknown"}`,
    );
    if (current && current.status === "success") {
      return await completeDisbursement(loanId, typedLoan);
    }
    if (current && FAILED_TRANSFER_STATUSES.has(current.status)) {
      return await failDisbursement(loanId, typedLoan, `Transfer ${current.status} at Paystack`);
    }
    // Name the live status: `received` means URL-approval is switched on for
    // the integration, in which case no OTP will ever finalize this transfer.
    throw new Error(
      `${msg}. Transfer is '${current?.status ?? "unknown"}' — try the OTP again.`,
    );
  }

  if (finalized.status === "success") {
    return await completeDisbursement(loanId, typedLoan);
  }
  if (FAILED_TRANSFER_STATUSES.has(finalized.status)) {
    return await failDisbursement(
      loanId,
      typedLoan,
      `Transfer ${finalized.status} at Paystack`,
    );
  }
  return {
    result: DisbursementResult.PendingOTP,
    paystack_transfer_ref: typedLoan.paystack_transfer_ref,
    message: "Transfer still processing. Awaiting confirmation via webhook.",
  };
}

/** Record a conclusively successful transfer: disbursed + stamped + notified. */async function completeDisbursement(
  loanId: string,
  loan: LoanWithProfile,
): Promise<DisbursementResponse> {
  const now = new Date().toISOString();

  await supabase
    .from("loans")
    .update({
      status: "disbursed",
      disbursed_at: now,
      updated_at: now,
    })
    .eq("id", loanId);

  await sendDisbursementSuccessNotification(loan);

  return {
    result: DisbursementResult.Success,
    paystack_transfer_ref: loan.paystack_transfer_ref ?? undefined,
    disbursed_at: now,
    message: "Loan disbursed successfully",
  };
}

/** Record a conclusively failed transfer and notify both sides. */
async function failDisbursement(
  loanId: string,
  loan: LoanWithProfile,
  message: string,
): Promise<DisbursementResponse> {
  await supabase
    .from("loans")
    .update({
      status: "disbursement_failed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", loanId);

  await sendDisbursementFailedNotification(loan);

  return {
    result: DisbursementResult.Failed,
    message,
  };
}

async function sendApprovalNotification(loan: LoanWithProfile): Promise<void> {
  // amount_approved / monthly_repayment / tenure_months are declared non-null
  // on LoanWithProfile but nullable in the database, and the caller reaches
  // this through an `as unknown as` cast that launders the difference away.
  // A bare `.toLocaleString()` on a null therefore throws — which is how an
  // approval notification used to fail silently. Route decisions now reject an
  // approval without terms, so this should be unreachable; degrade rather than
  // throw if it ever is, because a vaguer message beats no message at all.
  const hasTerms =
    loan.amount_approved != null &&
    loan.monthly_repayment != null &&
    loan.tenure_months != null;

  await NotificationService.getInstance().notify({
    userIds: [loan.member_id],
    type: "loan",
    title: "Loan Approved",
    body: hasTerms
      ? `Your loan of ₦${loan.amount_approved.toLocaleString()} has been approved! Monthly repayment: ₦${loan.monthly_repayment.toLocaleString()} for ${loan.tenure_months} months.`
      : "Your loan application has been approved. Open the app to see your repayment terms.",
    data: {
      event: "loan_approved",
      loan_id: loan.id,
      amount_approved: loan.amount_approved,
      monthly_repayment: loan.monthly_repayment,
      tenure_months: loan.tenure_months,
      interest_rate: loan.interest_rate,
    },
    action: { label: "View Details", url: `/loans/${loan.id}` },
  });
}

async function sendDisbursementSuccessNotification(loan: LoanWithProfile): Promise<void> {
  await NotificationService.getInstance().notify({
    userIds: [loan.member_id],
    type: "loan",
    title: "Loan Disbursed",
    body: `Your loan of ₦${loan.amount_approved.toLocaleString()} has been disbursed to your account (${loan.profiles.bank_name} - ${loan.profiles.bank_account}). First repayment due soon.`,
    data: {
      event: "loan_disbursed",
      loan_id: loan.id,
      amount_approved: loan.amount_approved,
    },
    action: { label: "View Details", url: `/loans/${loan.id}` },
    notifyAdmins: true,
  });
}

async function sendDisbursementFailedNotification(loan: LoanWithProfile): Promise<void> {
  await NotificationService.getInstance().notify({
    userIds: [loan.member_id],
    type: "loan",
    title: "Loan Disbursement Failed",
    body: "There was an issue disbursing your loan. Please contact support or update your bank details.",
    data: {
      event: "loan_disbursement_failed",
      loan_id: loan.id,
      member_id: loan.member_id,
      member_name: loan.profiles.full_name,
    },
    action: { label: "View Details", url: `/loans/${loan.id}` },
    notifyAdmins: true,
    pushAdmins: true,
  });
}

export async function notifyLoanApproved(loanId: string): Promise<void> {
  const { data: loan, error } = await supabase
    .from("loans")
    .select(
      `
      id,
      member_id,
      amount_approved,
      interest_rate,
      tenure_months,
      monthly_repayment,
      profiles (
        id,
        full_name,
        bank_account,
        bank_code,
        bank_name
      )
    `,
    )
    .eq("id", loanId)
    .single();

  if (error || !loan) {
    console.error("Failed to fetch loan for approval notification:", error);
    return;
  }

  const typedLoan = loan as unknown as LoanWithProfile;
  await sendApprovalNotification(typedLoan);
}
