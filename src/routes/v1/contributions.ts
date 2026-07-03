import Elysia, { t } from "elysia";
import { authenticate } from "@/middleware/authenticate";
import { requireAdmin } from "@/middleware/requireAdmin";
import { supabase } from "@/lib/supabase";
import { writeAuditLog } from "@/utils/audit";
import { paginate } from "@/utils/validators";
import { allocateContribution } from "@/services/contributionAllocation";
import { NotificationService } from "@/services/notificationService";
import { paystack } from "@/lib/paystack";
import type { Database } from "@/types/database";

const notificationService = NotificationService.getInstance();

export const contributionRoutes = new Elysia({ prefix: "/contributions" })
  .use(authenticate)

  // (tabs)/savings.tsx + transactions/contribution-details.tsx → GET /contributions/me
  // Returns all contributions with balance summary (calculated from successful contributions only)
  .get(
    "/me",
    async ({ userId: _userId, query }) => {
      const userId = _userId!;
      const year = query.year ?? new Date().getFullYear();
      const { from, to } = paginate(
        Number(query.page) || 1,
        Number(query.limit) || 20
      );

      const [allContributions, successfulContributions, transactions] = await Promise.all(
        [
          supabase
            .from("contributions")
            .select(
              "id, amount, shares, social, savings, deposit, year, month, transaction_ref, member_no, member_email, payment_method, payment_status, notes, created_at, updated_at",
              { count: "exact" }
            )
            .eq("member_id", userId)
            .order("created_at", { ascending: false })
            .range(from, to),

          supabase
            .from("contributions")
            .select("amount, shares, social, savings, deposit, month, year")
            .eq("member_id", userId)
            .eq("payment_status", "success"),

          supabase
            .from("transactions")
            .select(
              "id, amount, type, status, channel, description, created_at, paystack_ref",
              {
                count: "exact",
              },
            )
            .eq("member_id", userId)
            .order("created_at", { ascending: false })
            .range(from, to),
        ],
      );

      const successData = successfulContributions.data ?? [];

      // Calculate total savings balance from successful contributions only
      const totalBalance = successData.reduce((s, c) => s + Number(c.amount), 0);

      // Calculate allocation totals
      const totalShares = successData.reduce((s, c) => s + Number(c.shares ?? 0), 0);
      const totalSocial = successData.reduce((s, c) => s + Number(c.social ?? 0), 0);
      const totalSavings = successData.reduce((s, c) => s + Number(c.savings ?? 0), 0);
      const totalDeposit = successData.reduce((s, c) => s + Number(c.deposit ?? 0), 0);

      // Calculate yearly balance
      const yearBalance =
        successData
          .filter((c) => c.year === year)
          .reduce((s, c) => s + Number(c.amount), 0);

      // Calculate monthly breakdown
      const monthlyBreakdown =
        successData.reduce<Record<string, number>>((acc, c) => {
          acc[c.month] = (acc[c.month] ?? 0) + Number(c.amount);
          return acc;
        }, {});

      return {
        contributions: allContributions.data ?? [],
        total_count: allContributions.count ?? 0,
        total_balance: totalBalance,
        total_shares: totalShares,
        total_social: totalSocial,
        total_savings: totalSavings,
        total_deposit: totalDeposit,
        year_balance: yearBalance,
        monthly_breakdown: monthlyBreakdown,
        transactions: transactions.data,
        total_transactions: transactions.count,
        page: Number(query.page) || 1,
        limit: Number(query.limit) || 20,
      };
    },
    {
      query: t.Partial(
        t.Object({
          year: t.Numeric(),
          month: t.String(),
          page: t.Numeric(),
          limit: t.Numeric(),
        }),
      ),
    },
  )

  // transactions/add-contribution.tsx → POST /contributions
  // Allow pending users to create contributions.
  // Members cannot self-declare a paid contribution: non-admin submissions are
  // forced to "pending" — the paid path is POST /contributions/verify, where the
  // server confirms the payment with Paystack itself.
  .post(
    "/",
    async ({ userId: _userId, role, body }) => {
      const userId = _userId!;
      if (role !== "admin" && body.payment_status && body.payment_status !== "pending") {
        body.payment_status = "pending";
      }
      const isSuccess = body.payment_status === "success";
      const storedAmount = isSuccess ? body.amount * 100 : body.amount;
      const allocation = isSuccess ? allocateContribution(body.amount) : null;

      const { data, error } = await supabase
        .from("contributions")
        .insert({
          member_id: userId,
          amount: storedAmount,
          shares: allocation?.shares ?? null,
          social: allocation?.social ?? null,
          savings: allocation?.savings ?? null,
          deposit: allocation?.deposit ?? null,
          year: body.year,
          month: body.month,
          transaction_ref: body.transaction_ref ?? null,
          member_no: body.member_no ?? null,
          member_email: body.member_email ?? null,
          payment_method: body.payment_method ?? null,
          payment_status: body.payment_status ?? "pending",
          notes: body.notes ?? null,
        })
        .select()
        .single();
      if (error) throw new Error(error.message);

      if (isSuccess) {
        await notificationService.notify({
          userIds: [userId],
          type: "contribution",
          title: "Contribution Received",
          body: `Your contribution of ₦${body.amount.toLocaleString()} for ${body.month} has been recorded.`,
          data: { event: "contribution_recorded", contribution_id: data.id, amount: body.amount, month: body.month },
          action: { label: "View Contributions", url: "/contributions" },
          notifyAdmins: true,
        });
      }

      return data;
    },
    {
      body: t.Object({
        amount: t.Number({ minimum: 1 }),
        year: t.Number(),
        month: t.String({ pattern: "^[0-9]{4}-[0-9]{2}$" }),
        transaction_ref: t.Optional(t.String()),
        member_no: t.Optional(t.String()),
        member_email: t.Optional(t.String()),
        payment_method: t.Optional(t.String()),
        payment_status: t.Optional(
          t.Union([
            t.Literal("success"),
            t.Literal("failed"),
            t.Literal("abandoned"),
            t.Literal("pending"),
          ]),
        ),
        notes: t.Optional(t.String()),
      }),
    },
  )

  // transactions/add-contribution.tsx → POST /contributions/verify
  // Server-side Paystack verification: the client sends only the transaction
  // reference; amount and status come from Paystack, never from the client.
  .post(
    "/verify",
    async ({ userId: _userId, body, set }) => {
      const userId = _userId!;
      const reference = body.reference;

      // Idempotency pre-check (unique index on transaction_ref backs this up)
      const { data: existing } = await supabase
        .from("contributions")
        .select()
        .eq("transaction_ref", reference)
        .maybeSingle();
      if (existing) {
        return { verified: true, already_processed: true, contribution: existing };
      }

      let tx;
      try {
        tx = await paystack.verifyTransaction(reference);
      } catch (err) {
        set.status = 404;
        return {
          verified: false,
          reason: "reference_not_found",
          message: err instanceof Error ? err.message : "Verification failed",
        };
      }

      if (tx.status !== "success") {
        return { verified: false, status: tx.status };
      }
      if (tx.currency !== "NGN") {
        set.status = 422;
        return { verified: false, reason: "unsupported_currency", currency: tx.currency };
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
          return { verified: true, already_processed: true, contribution: winner };
        }
        throw new Error(`Failed to record transaction: ${txError.message}`);
      }

      const amountNaira = tx.amount / 100;
      const allocation = allocateContribution(amountNaira);

      const { data: contribution, error } = await supabase
        .from("contributions")
        .insert({
          member_id: userId,
          amount: tx.amount,
          shares: allocation.shares,
          social: allocation.social,
          savings: allocation.savings,
          deposit: allocation.deposit,
          year: body.year,
          month: body.month,
          transaction_ref: reference,
          member_no: body.member_no ?? null,
          member_email: body.member_email ?? null,
          payment_method: tx.channel,
          payment_status: "success",
          notes: body.notes ?? null,
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
        metadata: { paystack_ref: reference, amount: tx.amount, channel: tx.channel },
      });

      await notificationService.notify({
        userIds: [userId],
        type: "contribution",
        title: "Contribution Received",
        body: `Your contribution of ₦${amountNaira.toLocaleString()} for ${body.month} has been recorded.`,
        data: { event: "contribution_recorded", contribution_id: contribution.id, amount: amountNaira, month: body.month },
        action: { label: "View Contributions", url: "/contributions" },
        notifyAdmins: true,
      });

      return { verified: true, contribution };
    },
    {
      body: t.Object({
        reference: t.String({ minLength: 1 }),
        year: t.Number(),
        month: t.String({ pattern: "^[0-9]{4}-[0-9]{2}$" }),
        member_no: t.Optional(t.String()),
        member_email: t.Optional(t.String()),
        notes: t.Optional(t.String()),
      }),
    },
  )

  // transactions/contribution-details-info.tsx → GET /contributions/:id
  .get("/:id", async ({ params, userId: _userId, role }) => {
    const userId = _userId!;
    let q = supabase
      .from("contributions")
      .select("id, amount, shares, social, savings, deposit, year, month, transaction_ref, member_no, member_email, payment_method, payment_status, notes, created_at, updated_at, transactions(paystack_ref, channel, created_at)")
      .eq("id", params.id);

    if (role !== "admin") {
      q = q.eq("member_id", userId);
    }

    const { data, error } = await q.single();
    if (error) throw new Error("Contribution not found");
    return data;
  })

  // Admin routes
  .use(requireAdmin)

  .get(
    "/",
    async ({ query }) => {
      const { from, to } = paginate(query.page, query.limit);
      let q = supabase
        .from("contributions")
        .select("*, profiles(full_name, member_no)", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to);
      if (query.status) q = q.eq("payment_status", query.status);
      if (query.member_id) q = q.eq("member_id", query.member_id);
      if (query.year) q = q.eq("year", query.year);
      const { data, error, count } = await q;
      if (error) throw new Error(error.message);
      return { data, total: count };
    },
    {
      query: t.Partial(
        t.Object({
          page: t.Numeric(),
          limit: t.Numeric(),
          status: t.String(),
          member_id: t.String(),
          year: t.Numeric(),
        }),
      ),
    },
  )

  .patch(
    "/:id/status",
    async ({ params, body, userId: _userId }) => {
      const userId = _userId!;
      const isSuccess = body.status === "success";

      const { data: current } = await supabase
        .from("contributions")
        .select("amount")
        .eq("id", params.id)
        .single();

      if (!current) throw new Error("Contribution not found");

      const allocation = isSuccess
        ? allocateContribution(Number(current.amount) / 100)
        : null;

      const { data, error } = await supabase
        .from("contributions")
        .update({
          payment_status: body.status,
          shares: allocation?.shares ?? null,
          social: allocation?.social ?? null,
          savings: allocation?.savings ?? null,
          deposit: allocation?.deposit ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", params.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      await writeAuditLog({
        actor_id: userId,
        action: `contribution_${body.status}`,
        entity: "contributions",
        entity_id: params.id,
      });

      // Tell the member the outcome of the status review (skip pending)
      if (body.status !== "pending") {
        const amountNaira = Number(data.amount) / 100;
        await notificationService.notify({
          userIds: [data.member_id],
          type: "contribution",
          title: isSuccess ? "Contribution Confirmed" : "Contribution Issue",
          body: isSuccess
            ? `Your contribution of ₦${amountNaira.toLocaleString()} for ${data.month} has been confirmed.`
            : `Your contribution for ${data.month} was marked as ${body.status}. Please contact support if this is unexpected.`,
          data: { event: `contribution_${body.status}`, contribution_id: params.id, month: data.month },
          action: { label: "View Contributions", url: "/contributions" },
        });
      }

      return data;
    },
    {
      body: t.Object({
        status: t.Union([
          t.Literal("success"),
          t.Literal("failed"),
          t.Literal("abandoned"),
          t.Literal("pending"),
        ]),
      }),
    },
  );
