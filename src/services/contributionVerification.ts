import { supabase } from "@/lib/supabase";
import { paystack } from "@/lib/paystack";
import { writeAuditLog } from "@/utils/audit";
import { allocateContribution, MIN_CONTRIBUTION } from "@/services/contributionAllocation";
import { NotificationService } from "@/services/notificationService";
import type { Database } from "@/types/database";

const notificationService = NotificationService.getInstance();

export enum VerificationResult {
  Verified = "verified",
  AlreadyProcessed = "already_processed",
  ReferenceNotFound = "reference_not_found",
  PaymentNotSuccessful = "payment_not_successful",
  UnsupportedCurrency = "unsupported_currency",
  BelowMinimum = "below_minimum",
}

export interface VerificationInput {
  reference: string;
  year: number;
  month: string;
  member_no?: string;
  member_email?: string;
  notes?: string;
}

export interface VerificationResponse {
  result: VerificationResult;
  contribution?: unknown;
  message?: string;
  paystack_status?: string;
  currency?: string;
  amount?: number;
}

/**
 * Server-side Paystack verification for a member-initiated contribution:
 * the client sends only the transaction reference; amount and status come
 * from Paystack, never from the client.
 */
export async function verifyContributionPayment(
  userId: string,
  input: VerificationInput,
): Promise<VerificationResponse> {
  const reference = input.reference;

  // Idempotency pre-check (unique index on transaction_ref backs this up)
  const { data: existing } = await supabase
    .from("contributions")
    .select()
    .eq("transaction_ref", reference)
    .maybeSingle();
  if (existing) {
    return { result: VerificationResult.AlreadyProcessed, contribution: existing };
  }

  let tx;
  try {
    tx = await paystack.verifyTransaction(reference);
  } catch (err) {
    return {
      result: VerificationResult.ReferenceNotFound,
      message: err instanceof Error ? err.message : "Verification failed",
    };
  }

  if (tx.status !== "success") {
    return { result: VerificationResult.PaymentNotSuccessful, paystack_status: tx.status };
  }
  if (tx.currency !== "NGN") {
    return { result: VerificationResult.UnsupportedCurrency, currency: tx.currency };
  }

  const amountNaira = tx.amount / 100;
  // Reject below-minimum payments before any DB write so we neither orphan a
  // transaction row nor build a broken allocation (see docs/currency-contract.md).
  if (amountNaira < MIN_CONTRIBUTION) {
    return { result: VerificationResult.BelowMinimum, amount: amountNaira };
  }

  // Race-safe idempotency gate: transactions.paystack_ref is UNIQUE, so a
  // concurrent/replayed verify loses here and returns the existing record.
  const { error: txError } = await supabase.from("transactions").insert({
    paystack_ref: reference,
    member_id: userId,
    amount: tx.amount,
    type: "contribution",
    status: "success",
    channel: tx.channel,
    metadata: {
      gateway_response: tx.gateway_response,
      paid_at: tx.paid_at,
      verified_at: new Date().toISOString(),
    } as unknown as Database["public"]["Tables"]["transactions"]["Row"]["metadata"],
  });
  if (txError) {
    if (txError.code === "23505") {
      const { data: winner } = await supabase
        .from("contributions")
        .select()
        .eq("transaction_ref", reference)
        .maybeSingle();
      return { result: VerificationResult.AlreadyProcessed, contribution: winner };
    }
    throw new Error(`Failed to record transaction: ${txError.message}`);
  }

  const allocation = allocateContribution(amountNaira);

  const { data: contribution, error } = await supabase
    .from("contributions")
    .insert({
      member_id: userId,
      amount: amountNaira,
      shares: allocation.shares,
      social: allocation.social,
      savings: allocation.savings,
      deposit: allocation.deposit,
      year: input.year,
      month: input.month,
      transaction_ref: reference,
      member_no: input.member_no ?? null,
      member_email: input.member_email ?? null,
      payment_method: tx.channel,
      payment_status: "success",
      notes: input.notes ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  await supabase
    .from("transactions")
    .update({ contribution_id: contribution.id })
    .eq("paystack_ref", reference);

  await writeAuditLog({
    actor_id: userId,
    action: "contribution_verified",
    entity: "contributions",
    entity_id: contribution.id,
    metadata: { paystack_ref: reference, amount: amountNaira, channel: tx.channel },
  });

  await notificationService.notify({
    userIds: [userId],
    type: "contribution",
    title: "Contribution Received",
    body: `Your contribution of ₦${amountNaira.toLocaleString()} for ${input.month} has been recorded.`,
    data: {
      event: "contribution_recorded",
      contribution_id: contribution.id,
      amount: amountNaira,
      month: input.month,
    },
    action: { label: "View Contributions", url: "/contributions" },
    notifyAdmins: true,
  });

  return { result: VerificationResult.Verified, contribution };
}
