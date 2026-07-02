import Elysia, { t } from "elysia";
import { validateWebhook } from "@/middleware/validateWebhook";
import { supabase } from "@/lib/supabase";
import type { PaystackTransferEvent } from "@/lib/paystack";
import { NotificationService } from "@/services/notificationService";
import { writeAuditLog } from "@/utils/audit";

export const webhookRoutes = new Elysia({ prefix: "/webhooks" })
  .use(validateWebhook)
  .post(
    "/paystack",
    async (context) => {
      const webhookPayload = (context as any).webhookPayload;
      const signature = context.request.headers.get("x-paystack-signature");

      if (!signature || !webhookPayload) {
        return { received: true };
      }

      const event = webhookPayload as PaystackTransferEvent;
      console.log("[Paystack Webhook] Event received:", event.event);

      switch (event.event) {
        case "transfer.success":
          await handleTransferSuccess(event.data);
          break;
        case "transfer.failed":
          await handleTransferFailed(event.data);
          break;
        case "transfer.reversed":
          await handleTransferReversed(event.data);
          break;
        default:
          console.log(`[Paystack Webhook] Unhandled event type: ${event.event}`);
      }

      return { received: true };
    },
    {
      body: t.Object({
        event: t.String(),
        data: t.Object({
          reference: t.String(),
          amount: t.Number(),
          status: t.String(),
          transfer_code: t.String(),
          recipient: t.Object({
            recipient_code: t.String(),
            name: t.String(),
          }),
        }),
      }),
    },
  );

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