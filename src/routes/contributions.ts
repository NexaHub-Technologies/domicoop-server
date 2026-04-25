import Elysia, { t } from "elysia";
import { authenticate } from "../middleware/authenticate";
import { requireAdmin } from "../middleware/requireAdmin";
import { supabase } from "../lib/supabase";
import { writeAuditLog } from "../utils/audit";
import { paginationQS, paginate } from "../utils/validators";

export const contributionRoutes = new Elysia({ prefix: "/contributions" })
  .use(authenticate)

  // (tabs)/savings.tsx + transactions/contribution-details.tsx → GET /contributions/me
  // Returns all contributions with balance summary (calculated from successful contributions only)
  .get(
    "/me",
    async ({ userId, query }) => {
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
              "id, amount, year, month, transaction_ref, member_no, member_email, payment_method, payment_status, notes, created_at, updated_at",
              { count: "exact" }
            )
            .eq("member_id", userId)
            .order("created_at", { ascending: false })
            .range(from, to),

          supabase
            .from("contributions")
            .select("amount, month, year")
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

      // Calculate total savings balance from successful contributions only
      const totalBalance =
        successfulContributions.data?.reduce((s, c) => s + Number(c.amount), 0) ?? 0;

      // Calculate yearly balance
      const yearBalance =
        successfulContributions.data
          ?.filter((c) => c.year === year)
          .reduce((s, c) => s + Number(c.amount), 0) ?? 0;

      // Calculate monthly breakdown
      const monthlyBreakdown =
        successfulContributions.data?.reduce<Record<string, number>>((acc, c) => {
          acc[c.month] = (acc[c.month] ?? 0) + Number(c.amount);
          return acc;
        }, {}) ?? {};

      // Filter successful contributions by year if provided
      let filteredSuccessful = successfulContributions.data ?? [];
      if (query.year) {
        filteredSuccessful = filteredSuccessful.filter((c) => c.year === query.year);
      }

      return {
        contributions: allContributions.data ?? [],
        total_count: allContributions.count ?? 0,
        total_balance: totalBalance,
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
  // Allow pending users to create contributions
  .post(
    "/",
    async ({ userId, body }) => {
      const { data, error } = await supabase
        .from("contributions")
        .insert({
          member_id: userId,
          amount: body.payment_status === "success" ? body.amount * 100 : body.amount,
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
        payment_status: t.Optional(t.String()),
        notes: t.Optional(t.String()),
      }),
    },
  )

  // transactions/contribution-details-info.tsx → GET /contributions/:id
  .get("/:id", async ({ params, userId, role }) => {
    let q = supabase
      .from("contributions")
      .select("id, amount, year, month, transaction_ref, member_no, member_email, payment_method, payment_status, notes, created_at, updated_at, transactions(paystack_ref, channel, created_at)")
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
    async ({ params, body, userId }) => {
      const { data, error } = await supabase
        .from("contributions")
        .update({ payment_status: body.status, updated_at: new Date().toISOString() })
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
