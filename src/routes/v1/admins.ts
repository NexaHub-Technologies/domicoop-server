import Elysia, { t } from "elysia";
import { authenticate } from "@/middleware/authenticate";
import { requireAdmin } from "@/middleware/requireAdmin";
import { supabase } from "@/lib/supabase";
import { writeAuditLog } from "@/utils/audit";
import { uuidParam } from "@/utils/validators";

/**
 * Admin management routes.
 *
 * Admins live in the `admin_profiles` table (separate from member `profiles`);
 * a row there is what grants admin authorization. All routes here require an
 * existing admin. The very first admin is created out-of-band with
 * `scripts/create-admin.ts` (service role), since there is no admin to
 * authenticate the bootstrap call.
 */
export const adminRoutes = new Elysia({ prefix: "/admins" })
  .use(authenticate)
  .use(requireAdmin)

  // List all admins
  .get("/", async () => {
    const { data, error } = await supabase
      .from("admin_profiles")
      .select(
        "id, full_name, email, phone, avatar_url, is_super_admin, officer_role, created_at",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  })

  // Create a new admin. Creating the auth user with account_type=admin makes the
  // handle_new_user trigger insert into admin_profiles (not profiles).
  .post(
    "/",
    async ({ body, userId, set }) => {
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: body.email,
        password: body.password,
        email_confirm: true,
        user_metadata: {
          full_name: body.full_name,
          phone: body.phone,
        },
        // account_type lives in app_metadata, which GoTrue only accepts from
        // the admin API. handle_new_user() reads it from there so a public
        // signup can't mint an admin (migration 20260811000001).
        app_metadata: {
          account_type: "admin",
        },
      });
      if (authError) {
        set.status = 400;
        throw new Error(authError.message);
      }

      // Ensure the admin_profiles row exists even if the trigger is absent
      // (idempotent — the trigger normally creates it).
      await supabase.from("admin_profiles").upsert(
        {
          id: authData.user!.id,
          full_name: body.full_name,
          email: body.email,
          phone: body.phone ?? null,
        },
        { onConflict: "id" },
      );

      await writeAuditLog({
        actor_id: userId!,
        action: "create_admin",
        entity: "admin_profiles",
        entity_id: authData.user!.id,
      });

      set.status = 201;
      return { id: authData.user!.id, email: body.email, full_name: body.full_name };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 8 }),
        full_name: t.String({ minLength: 2 }),
        phone: t.Optional(t.String()),
      }),
    },
  )

  // Revoke an admin — deletes the auth user, which cascades the admin_profiles
  // row. Guards against removing yourself.
  /**
   * Assign or clear a cooperative office
   *
   * The Secretary and the President are the two signatures on Part C of a loan
   * application and on the bond. Holding an office is separate from being an
   * admin: it is what lets someone commit the cooperative to lending money.
   *
   * At most one person may hold each office (a partial unique index enforces
   * it), so handing the office to someone new means clearing the incumbent
   * first — deliberate friction for a change of officers.
   *
   * NOTE: this is gated on `requireAdmin`, not on `is_super_admin`. That column
   * exists but nothing in the codebase ever sets it, so gating on it would ship
   * an office nobody could ever assign. Tighten this the moment super-admin
   * provisioning is real.
   *
   * @route PATCH /admins/:id/office
   * @group Admins
   * @returns {Error} 409 - The office is already held by someone else
   */
  .patch(
    "/:id/office",
    async ({ params, body, userId, set }) => {
      const { data, error } = await supabase
        .from("admin_profiles")
        .update({ officer_role: body.officer_role })
        .eq("id", params.id)
        .select(
          "id, full_name, email, phone, avatar_url, is_super_admin, officer_role, created_at",
        )
        .single();

      if (error) {
        if (error.code === "23505") {
          set.status = 409;
          return {
            error: `The ${body.officer_role} office is already held. Clear it from the current holder first.`,
            reason: "office_taken",
          };
        }
        throw new Error(error.message);
      }

      await writeAuditLog({
        actor_id: userId!,
        action: body.officer_role ? "assign_officer_role" : "clear_officer_role",
        entity: "admin_profiles",
        entity_id: params.id,
        metadata: { officer_role: body.officer_role },
      });

      return data;
    },
    {
      params: uuidParam,
      body: t.Object({
        officer_role: t.Union([t.Literal("secretary"), t.Literal("president"), t.Null()]),
      }),
    },
  )

  .delete(
    "/:id",
    async ({ params, userId, set }) => {
      if (params.id === userId) {
        set.status = 400;
        throw new Error("You cannot revoke your own admin access");
      }

      const { data: existing } = await supabase
        .from("admin_profiles")
        .select("id")
        .eq("id", params.id)
        .maybeSingle();
      if (!existing) {
        set.status = 404;
        throw new Error("Admin not found");
      }

      const { error } = await supabase.auth.admin.deleteUser(params.id);
      if (error) throw new Error(error.message);

      await writeAuditLog({
        actor_id: userId!,
        action: "revoke_admin",
        entity: "admin_profiles",
        entity_id: params.id,
      });

      return new Response(null, { status: 204 });
    },
    { params: uuidParam },
  );
