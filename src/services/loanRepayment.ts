import { supabase } from "@/lib/supabase";
import { paystack } from "@/lib/paystack";
import { NotificationService } from "@/services/notificationService";
import type { Database } from "@/types/database";

export enum RepaymentResult {
  Success = "success",
  AlreadyProcessed = "already_processed",
  LoanNotFound = "loan_not_found",
  ReferenceNotFound = "reference_not_found",
  PaymentNotSuccessful = "payment_not_successful",
  UnsupportedCurrency = "unsupported_currency",
}

export interface RepaymentResponse {
  result: RepaymentResult;
  loan_id?: string;
  amount_paid?: number;
  remaining_balance?: number;
  loan_status?: string;
  message?: string;
  paystack_status?: string;
  currency?: string;
}

/**
 * Verify a Paystack payment server-side and apply it to the loan. The
 * client sends only the transaction reference; amount and status come
 * from Paystack, never from the client.
 */
export async function processLoanRepayment(
  loanId: string,
  memberId: string,
  reference: string,
): Promise<RepaymentResponse> {
  const { data: loan, error: loanError } = await supabase
    .from("loans")
    .select("id, member_id, balance, status")
    .eq("id", loanId)
    .eq("member_id", memberId)
    .single();

  if (loanError || !loan) {
    return { result: RepaymentResult.LoanNotFound };
  }

  let tx;
  try {
    tx = await paystack.verifyTransaction(reference);
  } catch (err) {
    return {
      result: RepaymentResult.ReferenceNotFound,
      message: err instanceof Error ? err.message : "Verification failed",
    };
  }

  if (tx.status !== "success") {
    return { result: RepaymentResult.PaymentNotSuccessful, paystack_status: tx.status };
  }
  if (tx.currency !== "NGN") {
    return { result: RepaymentResult.UnsupportedCurrency, currency: tx.currency };
  }

  // Record the transaction BEFORE touching the balance: paystack_ref is
  // UNIQUE, so a replayed reference fails here and cannot double-credit.
  const { error: txError } = await supabase.from("transactions").insert({
    paystack_ref: tx.reference,
    member_id: memberId,
    amount: tx.amount,
    type: "loan_repayment",
    status: "success",
    channel: tx.channel,
    loan_id: loanId,
    metadata: {
      gateway_response: tx.gateway_response,
      paid_at: tx.paid_at,
      verified_at: new Date().toISOString(),
    } as unknown as Database["public"]["Tables"]["transactions"]["Row"]["metadata"],
  });

  if (txError) {
    if (txError.code === "23505") {
      return {
        result: RepaymentResult.AlreadyProcessed,
        loan_id: loanId,
        remaining_balance: Number(loan.balance),
        loan_status: loan.status,
      };
    }
    throw new Error(`Failed to record transaction: ${txError.message}`);
  }

  const amount = tx.amount / 100;
  const newBalance = Math.max(0, Number(loan.balance) - amount);
  const newStatus = newBalance === 0 ? "closed" : "repaying";

  const { error: updateError } = await supabase
    .from("loans")
    .update({
      balance: newBalance,
      status: newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", loanId);

  if (updateError) {
    throw new Error(`Failed to update loan: ${updateError.message}`);
  }

  // Settle the schedule the borrower signed on Part A item 8. Applied oldest
  // first: a payment clears the earliest outstanding installment, which is what
  // "equal installments commencing [month]" means on the bond.
  //
  // Best-effort — the money is already recorded against the loan balance, which
  // is what governs closure. A schedule that drifts is a reporting problem, not
  // a financial one, so it is logged rather than allowed to fail a repayment.
  try {
    await applyToSchedule(loanId, amount);
  } catch (err) {
    console.error(`[Repayment] Could not update the schedule for loan ${loanId}:`, err);
  }

  if (newStatus === "closed") {
    // The bond is cancelled by the Secretary and the President, not
    // automatically — the paper deed has two signature lines for it. Tell them
    // there is something to sign.
    try {
      await NotificationService.getInstance().notify({
        userIds: [],
        type: "loan",
        title: "Loan fully repaid — bond awaiting cancellation",
        body: `A loan has been repaid in full. The Secretary and President need to sign the bond cancellation.`,
        data: { event: "loan_bond_awaiting_cancellation", loan_id: loanId },
        notifyAdmins: true,
        pushAdmins: true,
      });
    } catch (err) {
      console.error(`[Repayment] Could not notify officers for loan ${loanId}:`, err);
    }
  }

  await NotificationService.getInstance().notify({
    userIds: [memberId],
    type: "loan",
    title: "Loan Repayment Successful",
    body: `₦${amount.toLocaleString()} has been processed successfully.`,
    data: {
      event: "loan_repayment",
      loan_id: loanId,
      reference: tx.reference,
      amount: amount,
    },
    action: { label: "View Details", url: `/loans/${loanId}` },
    notifyAdmins: true,
  });

  return {
    result: RepaymentResult.Success,
    loan_id: loanId,
    amount_paid: amount,
    remaining_balance: newBalance,
    loan_status: newStatus,
  };
}

/**
 * Credit a payment against the outstanding installments, oldest first.
 *
 * A payment may span more than one installment (or fall short of one), so this
 * walks the schedule rather than assuming a 1:1 match between payments and
 * rows.
 */
async function applyToSchedule(loanId: string, amountNaira: number): Promise<void> {
  const { data: rows, error } = await supabase
    .from("loan_installments")
    .select("id, amount, paid_amount, status")
    .eq("loan_id", loanId)
    .neq("status", "paid")
    .order("installment_no", { ascending: true });

  if (error) throw new Error(error.message);

  let remaining = amountNaira;
  for (const row of rows ?? []) {
    if (remaining <= 0) break;
    const outstanding = Number(row.amount) - Number(row.paid_amount);
    const applied = Math.min(remaining, outstanding);
    const paid = Number(row.paid_amount) + applied;
    remaining = Math.round((remaining - applied) * 100) / 100;

    await supabase
      .from("loan_installments")
      .update({
        paid_amount: Math.round(paid * 100) / 100,
        status: paid >= Number(row.amount) ? "paid" : row.status,
      })
      .eq("id", row.id);
  }
}
