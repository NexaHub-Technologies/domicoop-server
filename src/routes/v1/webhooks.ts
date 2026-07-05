import Elysia from "elysia";
import { verifyPaystackSignature } from "@/middleware/validateWebhook";
import { supabase } from "@/lib/supabase";
import type { PaystackTransferEvent } from "@/lib/paystack";
import { NotificationService } from "@/services/notificationService";
import { writeAuditLog } from "@/utils/audit";
import { allocateContribution, MIN_CONTRIBUTION } from "@/services/contributionAllocation";

export const webhookRoutes = new Elysia({ prefix: "/webhooks" })
  .post(
    "/paystack",
    async ({ body, request, set }) => {
      // Custom parse keeps the raw body string: the HMAC is computed over the
      // exact bytes Paystack sent, so we must not JSON-parse before verifying.
      const rawBody = body as string;
      const signature = request.headers.get("x-paystack-signature");

      if (!signature || !verifyPaystackSignature(rawBody, signature)) {
        set.status = 401;
        return { error: "Invalid webhook signature" };
      }

      let event: { event: string; data: unknown };
      try {
        event = JSON.parse(rawBody);
      } catch {
        set.status = 400;
        return { error: "Invalid JSON payload" };
      }
      console.log("[Paystack Webhook] Event received:", event.event);

      switch (event.event) {
        case "charge.success":
          await handleChargeSuccess(event.data as PaystackChargeEventData);
          break;
        case "transfer.success":
          await handleTransferSuccess(event.data as PaystackTransferEvent["data"]);
          break;
        case "transfer.failed":
          await handleTransferFailed(event.data as PaystackTransferEvent["data"]);
          break;
        case "transfer.reversed":
          await handleTransferReversed(event.data as PaystackTransferEvent["data"]);
          break;
        default:
          console.log(`[Paystack Webhook] Unhandled event type: ${event.event}`);
      }

      return { received: true };
    },
    {
      // Keep the raw body for signature verification; event shapes differ per
      // event type (charge.* vs transfer.*), handlers narrow the payload.
      parse: ({ request }) => request.text(),
    },
  );

interface PaystackChargeEventData {
  reference: string;
  amount: number;
  status: string;
  currency: string;
  channel: string;
  paid_at: string | null;
  customer?: { email?: string };
}

/**
 * Independent server-side payment confirmation. If a pending contribution
 * exists for this reference, confirm it (allocation + notification). If the
 * reference was already processed by POST /contributions/verify, no-op.
 */
async function handleChargeSuccess(data: PaystackChargeEventData): Promise<void> {
  const reference = data.reference;
  if (!reference || data.status !== "success") return;

  // Already settled by the /verify endpoint (or an earlier webhook delivery)?
  const { data: existingTx } = await supabase
    .from("transactions")
    .select("id")
    .eq("paystack_ref", reference)
    .maybeSingle();
  if (existingTx) {
    console.log(`[Paystack Webhook] charge.success ${reference} already processed`);
    return;
  }

  const { data: contribution } = await supabase
    .from("contributions")
    .select()
    .eq("transaction_ref", reference)
    .maybeSingle();

  if (!contribution) {
    console.log(`[Paystack Webhook] charge.success ${reference} matches no contribution, skipping`);
    return;
  }
  if (contribution.payment_status === "success") return;

  const amountNaira = data.amount / 100;
  // Below-minimum payments cannot form a valid allocation (see mds/allocation.md).
  // Skip rather than corrupt data or trigger Paystack webhook retries.
  if (amountNaira < MIN_CONTRIBUTION) {
    console.error(
      `[Paystack Webhook] charge.success ${reference} amount ₦${amountNaira} below minimum ₦${MIN_CONTRIBUTION}; skipping`,
    );
    return;
  }

  // Idempotency gate: unique paystack_ref; a concurrent /verify wins and this no-ops
  const { error: txError } = await supabase.from("transactions").insert({
    paystack_ref: reference,
    member_id: contribution.member_id,
    amount: data.amount,
    type: "contribution",
    status: "success",
    channel: data.channel,
    contribution_id: contribution.id,
    metadata: {
      source: "webhook_charge_success",
      paid_at: data.paid_at,
      processed_at: new Date().toISOString(),
    },
  });
  if (txError) {
    if (txError.code !== "23505") {
      console.error("[Paystack Webhook] Failed to record charge transaction:", txError);
    }
    return;
  }

  const allocation = allocateContribution(amountNaira);

  const { error: updateError } = await supabase
    .from("contributions")
    .update({
      payment_status: "success",
      amount: amountNaira,
      shares: allocation.shares,
      social: allocation.social,
      savings: allocation.savings,
      deposit: allocation.deposit,
      payment_method: data.channel,
      updated_at: new Date().toISOString(),
    })
    .eq("id", contribution.id);
  if (updateError) {
    console.error("[Paystack Webhook] Failed to confirm contribution:", updateError);
    return;
  }

  await NotificationService.getInstance().notify({
    userIds: [contribution.member_id],
    type: "contribution",
    title: "Contribution Received",
    body: `Your contribution of ₦${amountNaira.toLocaleString()} for ${contribution.month} has been confirmed.`,
    data: { event: "contribution_recorded", contribution_id: contribution.id, amount: amountNaira, month: contribution.month },
    action: { label: "View Contributions", url: "/contributions" },
    notifyAdmins: true,
  });

  await writeAuditLog({
    actor_id: "webhook",
    action: "contribution_verified",
    entity: "contributions",
    entity_id: contribution.id,
    metadata: { paystack_ref: reference, amount: amountNaira, channel: data.channel },
  });

  console.log(`[Paystack Webhook] Contribution ${contribution.id} confirmed via charge.success`);
}

async function handleTransferSuccess(data: PaystackTransferEvent["data"]): Promise<void> {
  const reference = data.reference;

  if (!reference || !reference.startsWith("LOAN-")) {
    console.log("[Paystack Webhook] Ignoring non-loan transfer:", reference);
    return;
  }

  const { data: loan, error: loanError } = await supabase
    .from("loans")
    .select("*")
    .eq("paystack_transfer_ref", reference)
    .single();

  if (loanError || !loan) {
    console.error("[Paystack Webhook] Loan not found for reference:", reference, loanError);
    return;
  }

  const now = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("loans")
    .update({
      status: "disbursed",
      disbursed_at: now,
      updated_at: now,
    })
    .eq("id", loan.id);

  if (updateError) {
    console.error("[Paystack Webhook] Failed to update loan status:", updateError);
    return;
  }

  const { data: member } = await supabase
    .from("profiles")
    .select("full_name, bank_account, bank_name")
    .eq("id", loan.member_id)
    .single();

  const amount = Math.floor(data.amount / 100);
  const bankName = member?.bank_name || "your bank";
  const bankAccount = member?.bank_account || "****";

  await NotificationService.getInstance().notify({
    userIds: [loan.member_id],
    type: "loan",
    title: "Loan Disbursed",
    body: `Your loan of ₦${amount.toLocaleString()} has been disbursed to your account (${bankName} - ${bankAccount}). First repayment due soon.`,
    data: {
      event: "loan_disbursed",
      loan_id: loan.id,
      amount_approved: amount,
    },
    action: { label: "View Details", url: `/loans/${loan.id}` },
    notifyAdmins: true,
  });

  await writeAuditLog({
    actor_id: "webhook",
    action: "loan_disbursement_completed",
    entity: "loans",
    entity_id: loan.id,
    metadata: {
      paystack_transfer_ref: reference,
      transfer_code: data.transfer_code,
      completed_at: now,
    },
  });

  console.log(`[Paystack Webhook] Loan ${loan.id} marked as disbursed`);
}

async function handleTransferFailed(data: PaystackTransferEvent["data"]): Promise<void> {
  const reference = data.reference;

  if (!reference || !reference.startsWith("LOAN-")) {
    console.log("[Paystack Webhook] Ignoring non-loan transfer:", reference);
    return;
  }

  const { data: loan, error: loanError } = await supabase
    .from("loans")
    .select("*")
    .eq("paystack_transfer_ref", reference)
    .single();

  if (loanError || !loan) {
    console.error("[Paystack Webhook] Loan not found for reference:", reference, loanError);
    return;
  }

  const now = new Date().toISOString();

  await supabase
    .from("loans")
    .update({
      status: "disbursement_failed",
      updated_at: now,
    })
    .eq("id", loan.id);

  await NotificationService.getInstance().notify({
    userIds: [loan.member_id],
    type: "loan",
    title: "Loan Disbursement Failed",
    body: "There was an issue disbursing your loan. Please contact support or update your bank details.",
    data: {
      event: "loan_disbursement_failed",
      loan_id: loan.id,
      member_id: loan.member_id,
      reference,
    },
    action: { label: "View Details", url: `/loans/${loan.id}` },
    notifyAdmins: true,
    pushAdmins: true,
  });

  await writeAuditLog({
    actor_id: "webhook",
    action: "loan_disbursement_failed",
    entity: "loans",
    entity_id: loan.id,
    metadata: {
      paystack_transfer_ref: reference,
      transfer_code: data.transfer_code,
      failed_at: now,
    },
  });

  console.log(`[Paystack Webhook] Loan ${loan.id} marked as disbursement_failed`);
}

async function handleTransferReversed(data: PaystackTransferEvent["data"]): Promise<void> {
  const reference = data.reference;

  if (!reference || !reference.startsWith("LOAN-")) {
    console.log("[Paystack Webhook] Ignoring non-loan transfer:", reference);
    return;
  }

  const { data: loan, error: loanError } = await supabase
    .from("loans")
    .select("*")
    .eq("paystack_transfer_ref", reference)
    .single();

  if (loanError || !loan) {
    console.error("[Paystack Webhook] Loan not found for reference:", reference, loanError);
    return;
  }

  // Admin-only: no member inbox row, just admin WS channel + admin push
  await NotificationService.getInstance().notify({
    userIds: [],
    type: "loan",
    title: "Loan Disbursement Reversed",
    body: `A loan disbursement for loan ${loan.id} has been reversed by Paystack. Immediate action required.`,
    data: {
      event: "loan_disbursement_reversed",
      loan_id: loan.id,
      member_id: loan.member_id,
      reference,
    },
    notifyAdmins: true,
    pushAdmins: true,
  });

  await writeAuditLog({
    actor_id: "webhook",
    action: "loan_disbursement_reversed",
    entity: "loans",
    entity_id: loan.id,
    metadata: {
      paystack_transfer_ref: reference,
      transfer_code: data.transfer_code,
      reversed_at: new Date().toISOString(),
    },
  });

  console.log(`[Paystack Webhook] Loan ${loan.id} disbursement was reversed`);
}