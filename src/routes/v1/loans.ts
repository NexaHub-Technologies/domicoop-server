import Elysia, { t } from "elysia";
import { authenticate } from "@/middleware/authenticate";
import { requireAdmin } from "@/middleware/requireAdmin";
import { requireActive } from "@/middleware/requireActive";
import { supabase } from "@/lib/supabase";
import { paystack } from "@/lib/paystack";
import { writeAuditLog } from "@/utils/audit";
import { paginationQS, paginate } from "@/utils/validators";
import type { Database } from "@/types/database";
import { disburseLoan, notifyLoanApproved } from "@/services/loanDisbursement";
import { NotificationService } from "@/services/notificationService";

type LoanUpdate = Database["public"]["Tables"]["loans"]["Update"];

export const loanRoutes = new Elysia({ prefix: "/loans" })
  .use(authenticate)

  // (tabs)/loans.tsx → GET /loans/me
  .get("/me", async ({ userId }) => {
    const { data, error } = await supabase
      .from("loans")
      .select("*")
      .eq("member_id", userId!)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  })

  // transactions/apply-for-loan.tsx → POST /loans/apply
  // Requires active account status (pending users cannot apply for loans)
  .use(requireActive)
  .post(
    "/apply",
    async ({ userId, body }) => {
      const { count } = await supabase
        .from("contributions")
        .select("*", { count: "exact", head: true })
        .eq("member_id", userId!)
        .eq("payment_status", "success");

      if ((count ?? 0) < 3)
        throw new Error("Minimum 3 verified contributions required to apply");

      const { data: existing } = await supabase
        .from("loans")
        .select("id")
        .eq("member_id", userId!)
        .in("status", ["pending", "under_review", "approved", "disbursed", "repaying"])
        .maybeSingle();

      if (existing) throw new Error("You already have an active loan");

      const { data, error } = await supabase
        .from("loans")
        .insert({
          member_id: userId!,
          amount_requested: body.amount,
          purpose: body.purpose,
          type: body.type,
          tenure_months: body.tenure_months,
          status: "pending",
        })
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    },
    {
      body: t.Object({
        amount: t.Number({ minimum: 1000 }),
        purpose: t.String({ minLength: 10 }),
        type: t.Union([
          t.Literal("emergency"),
          t.Literal("personal"),
          t.Literal("housing"),
          t.Literal("education"),
          t.Literal("business"),
        ]),
        tenure_months: t.Number({ minimum: 1, maximum: 36 }),
      }),
    },
  )

  // loans/[id].tsx → GET /loans/:id
  .get("/:id", async ({ params, userId }) => {
    const { data, error } = await supabase
      .from("loans")
      .select("*, transactions(paystack_ref, amount, created_at, channel)")
      .eq("id", params.id)
      .eq("member_id", userId!)
      .single();
    if (error) throw new Error("Loan not found");
    return data;
  })

  // POST /loans/:id/repayment - Verify a Paystack payment server-side and apply
  // it to the loan. The client sends only the transaction reference; amount and
  // status come from Paystack, never from the client.
  .post(
    "/:id/repayment",
    async ({ params, body, userId, set }) => {
      const { data: loan, error: loanError } = await supabase
        .from("loans")
        .select("id, member_id, balance, status")
        .eq("id", params.id)
        .eq("member_id", userId!)
        .single();

      if (loanError || !loan) {
        throw new Error("Loan not found or does not belong to member");
      }

      let tx;
      try {
        tx = await paystack.verifyTransaction(body.reference);
      } catch (err) {
        set.status = 404;
        return {
          success: false,
          reason: "reference_not_found",
          message: err instanceof Error ? err.message : "Verification failed",
        };
      }

      if (tx.status !== "success") {
        set.status = 402;
        return { success: false, reason: "payment_not_successful", status: tx.status };
      }
      if (tx.currency !== "NGN") {
        set.status = 422;
        return { success: false, reason: "unsupported_currency", currency: tx.currency };
      }

      // Record the transaction BEFORE touching the balance: paystack_ref is
      // UNIQUE, so a replayed reference fails here and cannot double-credit.
      const { error: txError } = await supabase.from("transactions").insert({
        paystack_ref: tx.reference,
        member_id: userId!,
        amount: tx.amount,
        type: "loan_repayment",
        status: "success",
        channel: tx.channel,
        loan_id: params.id,
        metadata: {
          gateway_response: tx.gateway_response,
          paid_at: tx.paid_at,
          verified_at: new Date().toISOString(),
        } as unknown as Database["public"]["Tables"]["transactions"]["Row"]["metadata"],
      });

      if (txError) {
        if (txError.code === "23505") {
          return {
            success: true,
            already_processed: true,
            loan_id: params.id,
            remaining_balance: Number(loan.balance),
            status: loan.status,
          };
        }
        throw new Error(`Failed to record transaction: ${txError.message}`);
      }

      const amount = tx.amount / 100;
      const newBalance = Math.max(0, Number(loan.balance) - amount);

      const { error: updateError } = await supabase
        .from("loans")
        .update({
          balance: newBalance,
          status: newBalance === 0 ? "closed" : "repaying",
          updated_at: new Date().toISOString(),
        })
        .eq("id", params.id);

      if (updateError) {
        throw new Error(`Failed to update loan: ${updateError.message}`);
      }

      await NotificationService.getInstance().notify({
        userIds: [userId!],
        type: "loan",
        title: "Loan Repayment Successful",
        body: `₦${amount.toLocaleString()} has been processed successfully.`,
        data: {
          event: "loan_repayment",
          loan_id: params.id,
          reference: tx.reference,
          amount: amount,
        },
        action: { label: "View Details", url: `/loans/${params.id}` },
        notifyAdmins: true,
      });

      return {
        success: true,
        loan_id: params.id,
        amount_paid: amount,
        remaining_balance: newBalance,
        status: newBalance === 0 ? "closed" : "repaying",
      };
    },
    {
      body: t.Object({
        reference: t.String({ minLength: 1 }),
      }),
    },
  )

  .use(requireAdmin)

  .get(
    "/",
    async ({ query }) => {
      const { from, to } = paginate(query.page, query.limit);
      let q = supabase
        .from("loans")
        .select("*, profiles(full_name, member_no)", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to);
      if (query.status) q = q.eq("status", query.status);
      const { data, error, count } = await q;
      if (error) throw new Error(error.message);
      return { data, total: count };
    },
    {
      query: t.Partial(
        t.Object({ page: t.Numeric(), limit: t.Numeric(), status: t.String() }),
      ),
    },
  )

  .patch(
    "/:id/process",
    async ({ params, body, userId }) => {
      const updates: LoanUpdate = {
        status: body.status,
        admin_notes: body.admin_notes ?? null,
        updated_at: new Date().toISOString(),
      };
      if (body.status === "approved" && body.amount_approved) {
        const rate = body.interest_rate ?? 5;
        const total = body.amount_approved * (1 + rate / 100);
        updates.amount_approved = body.amount_approved;
        updates.interest_rate = rate;
        updates.tenure_months = body.tenure_months;
        updates.monthly_repayment = parseFloat((total / body.tenure_months!).toFixed(2));
        updates.balance = parseFloat(total.toFixed(2));
        updates.due_date = new Date(
          Date.now() + body.tenure_months! * 30 * 86400000,
        ).toISOString();
      }
      const { data, error } = await supabase
        .from("loans")
        .update(updates)
        .eq("id", params.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      await writeAuditLog({
        actor_id: userId!,
        action: `loan_${body.status}`,
        entity: "loans",
        entity_id: params.id,
      });

      if (body.status === "approved") {
        await notifyLoanApproved(params.id);
      } else if (body.status === "rejected") {
        await NotificationService.getInstance().notify({
          userIds: [data.member_id],
          type: "loan",
          title: "Loan Application Update",
          body: "Your loan application was not approved. Please contact support for details.",
          data: { event: "loan_rejected", loan_id: params.id },
          action: { label: "View Details", url: `/loans/${params.id}` },
        });
      }

      return data;
    },
    {
      body: t.Object({
        status: t.Union([
          t.Literal("approved"),
          t.Literal("rejected"),
          t.Literal("under_review"),
          t.Literal("disbursed"),
        ]),
        amount_approved: t.Optional(t.Number()),
        interest_rate: t.Optional(t.Number()),
        tenure_months: t.Optional(t.Number()),
        admin_notes: t.Optional(t.String()),
      }),
    },
  )

  .post("/:id/disburse", async ({ params, userId }) => {
    const { data: loan, error: loanError } = await supabase
      .from("loans")
      .select("id, status, amount_approved")
      .eq("id", params.id)
      .single();

    if (loanError || !loan) {
      throw new Error("Loan not found");
    }

    if (loan.status !== "approved") {
      throw new Error(
        `Loan must be in 'approved' status to disburse. Current status: ${loan.status}`,
      );
    }

    if (!loan.amount_approved || loan.amount_approved <= 0) {
      throw new Error("Loan has no approved amount to disburse");
    }

    const result = await disburseLoan(params.id);

    await writeAuditLog({
      actor_id: userId!,
      action: `loan_disbursement_${result.result}`,
      entity: "loans",
      entity_id: params.id,
      metadata: {
        paystack_transfer_ref: result.paystack_transfer_ref,
        recipient_code: result.recipient_code,
      },
    });

    if (result.result === "success") {
      return {
        success: true,
        status: "disbursed",
        paystack_transfer_ref: result.paystack_transfer_ref,
        disbursed_at: result.disbursed_at,
        message: "Loan disbursed successfully",
      };
    } else if (result.result === "pending_otp") {
      return {
        success: true,
        status: "pending_otp",
        paystack_transfer_ref: result.paystack_transfer_ref,
        message: result.message || "Transfer initiated. Awaiting OTP confirmation.",
      };
    } else {
      return {
        success: false,
        status: "disbursement_failed",
        message: result.message || "Disbursement failed",
      };
    }
  });
