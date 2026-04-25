import Elysia, { t } from "elysia";
import { authenticate } from "../middleware/authenticate";
import { requireAdmin } from "../middleware/requireAdmin";
import { supabase } from "../lib/supabase";
import { writeAuditLog } from "../utils/audit";
import { paginationQS, paginate } from "../utils/validators";

export const memberRoutes = new Elysia({ prefix: "/members" })

  .use(authenticate)

  // profile.tsx → GET /members/me
  .get("/me", async ({ userId }) => {
    const { data, error } = await supabase
      .from("profiles")
      .select(
        "id, full_name, email, phone, address, bank_name, bank_account, bank_code, next_of_kin, role, status, member_no, avatar_url, created_at",
      )
      .eq("id", userId)
      .single();
    if (error) throw new Error("Profile not found");
    return data;
  })

  // edit-profile.tsx → PATCH /members/me
  .patch(
    "/me",
    async ({ userId, body }) => {
      const { data, error } = await supabase
        .from("profiles")
        .update({ ...body, updated_at: new Date().toISOString() })
        .eq("id", userId)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    },
    {
      body: t.Partial(
        t.Object({
          full_name: t.String(),
          phone: t.String(),
          address: t.String(),
          bank_name: t.String(),
          bank_account: t.String(),
          bank_code: t.String(),
          next_of_kin: t.String(),
          avatar_url: t.String(),
        }),
      ),
    },
  )

  // security.tsx → GET /members/me/security
  // Returns non-sensitive security metadata — 2FA status, last login, active sessions count
  .get("/me/security", async ({ userId }) => {
    const { data: authUser } = await supabase.auth.admin.getUserById(userId);
    return {
      email: authUser.user?.email,
      email_confirmed: !!authUser.user?.email_confirmed_at,
      last_sign_in: authUser.user?.last_sign_in_at,
      mfa_enabled: (authUser.user?.factors?.length ?? 0) > 0,
      created_at: authUser.user?.created_at,
    };
  })

  // Admin routes
  .use(requireAdmin)

  // Admin creates a new member account (admin-only)
  .post(
    "/",
    async ({ body }) => {
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: body.email,
        password: body.password,
        user_metadata: { full_name: body.full_name, role: "member" },
      });
      if (authError) throw new Error(authError.message);
      await supabase
        .from("profiles")
        .update({
          phone: body.phone,
          address: body.address,
          next_of_kin: body.next_of_kin ?? null,
          status: "pending",
        })
        .eq("id", authData.user!.id);
      return {
        message: "Registration submitted. Proceed to onboarding.",
        id: authData.user!.id,
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 8 }),
        full_name: t.String({ minLength: 2 }),
        phone: t.String(),
        address: t.String(),
        next_of_kin: t.Optional(t.String()),
      }),
    },
  )

  .get(
    "/",
    async ({ query }) => {
      const { from, to } = paginate(query.page, query.limit);
      const { data, count, error } = await supabase
        .from("profiles")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to);
      if (error) throw new Error(error.message);
      return { data, total: count, page: query.page ?? 1, limit: query.limit ?? 20 };
    },
    { query: paginationQS },
  )

  .get("/:id", async ({ params }) => {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", params.id)
      .single();
    if (error) throw new Error("Member not found");
    return data;
  })

  .patch(
    "/:id",
    async ({ params, body, userId }) => {
      const { data, error } = await supabase
        .from("profiles")
        .update({ ...body, updated_at: new Date().toISOString() })
        .eq("id", params.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      await writeAuditLog({
        actor_id: userId,
        action: "update_member",
        entity: "profiles",
        entity_id: params.id,
      });
      return data;
    },
    {
      body: t.Partial(
        t.Object({
          status: t.Union([
            t.Literal("pending"),
            t.Literal("active"),
            t.Literal("suspended"),
          ]),
          role: t.Union([t.Literal("member"), t.Literal("admin")]),
          member_no: t.String(),
        }),
      ),
    },
  )

  .get("/applications/pending", async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return data;
  })

  .post("/:id/approve", async ({ params, userId }) => {
    const { count } = await supabase
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .eq("status", "active");
    const memberNo = `DOMICOP-${String((count ?? 0) + 1).padStart(4, "0")}`;
    const { data, error } = await supabase
      .from("profiles")
      .update({
        status: "active",
        member_no: memberNo,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    await writeAuditLog({
      actor_id: userId,
      action: "approve_member",
      entity: "profiles",
      entity_id: params.id,
    });
    return data;
  })

  // Admin financial statement for a member
  .get(
    "/:id/statement",
    async ({ params, query }) => {
      const year = query.year ?? new Date().getFullYear();

      const [profile, contributions, loans, transactions] = await Promise.all([
        supabase.from("profiles")
          .select("id, full_name, member_no, phone, address, status, created_at")
          .eq("id", params.id).single(),

        supabase.from("contributions")
          .select("*")
          .eq("member_id", params.id)
          .eq("year", year)
          .order("month", { ascending: true }),

        supabase.from("loans")
          .select("*")
          .eq("member_id", params.id)
          .order("created_at", { ascending: false }),

        supabase.from("transactions")
          .select("*")
          .eq("member_id", params.id)
          .order("created_at", { ascending: false }),
      ]);

      if (!profile.data) throw new Error("Member not found");

      const totalContributions = contributions.data
        ?.filter((c) => c.payment_status === "success")
        .reduce((s, c) => s + Number(c.amount), 0) ?? 0;

      const activeLoans = loans.data?.filter((l) =>
        ["disbursed", "repaying"].includes(l.status)
      ) ?? [];

      return {
        year,
        member: profile.data,
        contributions: {
          total: totalContributions,
          items: contributions.data,
        },
        loans: {
          total: loans.data?.length ?? 0,
          active: activeLoans.length,
          outstanding_balance: activeLoans.reduce((s, l) => s + Number(l.balance), 0),
          items: loans.data,
        },
        transactions: {
          total: transactions.data?.length ?? 0,
          items: transactions.data,
        },
      };
    },
    { query: t.Partial(t.Object({ year: t.Numeric() })) }
  );
