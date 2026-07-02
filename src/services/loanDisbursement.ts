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

export interface LoanWithProfile {
  id: string;
  member_id: string;
  amount_approved: number;
  interest_rate: number;
  tenure_months: number;
  monthly_repayment: number;
  balance: number;
  status: string;
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

  if (typedLoan.status !== "approved") {
    throw new Error(
      `Loan must be in approved status to disburse. Current status: ${typedLoan.status}`,
    );
  }

  try {
    const verification = await paystack.resolveAccount(
      member.bank_account,
      member.bank_code,
    );

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
    const reference = `LOAN-${loanId.slice(0, 8)}-${timestamp}`;

    const transfer = await paystack.initiateTransfer({
      amount: typedLoan.amount_approved,
      recipient: recipient.recipient_code,
      reference,
      reason: `Loan disbursement for ${member.full_name}`,
    });

    if (transfer.status === "failed") {
      await supabase
        .from("loans")
        .update({
          status: "disbursement_failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", loanId);

      await sendDisbursementFailedNotification(typedLoan as unknown as LoanWithProfile);

      return {
        result: DisbursementResult.Failed,
        message: "Transfer failed at Paystack",
      };
    }

    const isSuccess = transfer.status === "success";
    const now = new Date().toISOString();

    await supabase
      .from("loans")
      .update({
        status: isSuccess ? "disbursed" : "approved",
        paystack_transfer_ref: reference,
        recipient_code: recipient.recipient_code,
        disbursed_at: isSuccess ? now : null,
        updated_at: now,
      } as any)
      .eq("id", loanId);

    if (isSuccess) {
      await sendDisbursementSuccessNotification(typedLoan);
    }

    return {
      result: isSuccess ? DisbursementResult.Success : DisbursementResult.PendingOTP,
      paystack_transfer_ref: reference,
      recipient_code: recipient.recipient_code,
      disbursed_at: isSuccess ? now : undefined,
      message: isSuccess
        ? "Loan disbursed successfully"
        : "Transfer initiated. Awaiting OTP confirmation via webhook.",
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
      message:
        error instanceof Error ? error.message : "Unknown error during disbursement",
    };
  }
}

async function sendApprovalNotification(loan: LoanWithProfile): Promise<void> {
  await NotificationService.getInstance().notify({
    userIds: [loan.member_id],
    type: "loan",
    title: "Loan Approved",
    body: `Your loan of ₦${loan.amount_approved.toLocaleString()} has been approved! Monthly repayment: ₦${loan.monthly_repayment.toLocaleString()} for ${loan.tenure_months} months.`,
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
