import Elysia, { t } from "elysia";
import { supabase } from "@/lib/supabase";
import type { Database } from "@/types/database";
import { authenticate } from "@/middleware/authenticate";
import { requireAdmin } from "@/middleware/requireAdmin";
import { authRateLimit } from "@/middleware/rateLimiter";
import { writeAuditLog } from "@/utils/audit";
import { uuidParam } from "@/utils/validators";
import {
  getActiveWindow,
  getLastClosedWindow,
  RegistrationClosedError,
  type RegistrationWindowRow,
} from "@/services/registrationWindow";
import {
  registerMember,
  precheckApplication,
  registrationTotal,
  signedSignatureUrl,
  RegistrationError,
} from "@/services/memberRegistration";

/**
 * Membership Registration Portal
 *
 * The cooperative registers members in time-boxed intakes rather than
 * continuously. This module owns both halves of that: the public surface an
 * applicant sees (is the portal open, and here is my paid application) and the
 * admin surface that schedules, opens and closes an intake.
 *
 * @module routes/registration
 */

/**
 * The applicant-facing view of a window.
 *
 * Deliberately narrower than the row: `capacity`, `applications_count` and the
 * window id are the cooperative's business, not an applicant's, and knowing
 * exactly how many slots remain invites a stampede. `slots_remaining` is
 * exposed only as a coarse hint when a cap exists.
 */
function publicWindow(window: RegistrationWindowRow, slotsRemaining: number | null) {
  return {
    name: window.name,
    opens_at: window.opens_at,
    closes_at: window.closes_at,
    registration_fee: Number(window.registration_fee),
    social_fee: Number(window.social_fee),
    total_due: registrationTotal(window),
    min_monthly_subscription: Number(window.min_monthly_subscription),
    max_monthly_subscription: Number(window.max_monthly_subscription),
    slots_remaining: slotsRemaining,
  };
}

export const registrationRoutes = new Elysia({ prefix: "/registration" })

  // ==========================================================================
  // Public
  // ==========================================================================
  .use(authRateLimit)

  /**
   * Current registration window
   *
   * Called before the sign-up form is offered, so the app can show the closed
   * screen instead of a form nobody can submit. Unauthenticated by necessity —
   * the caller has no account yet.
   *
   * @route GET /registration/window
   * @group Registration
   * @returns {boolean} 200.is_open - Whether applications are being accepted right now
   * @returns {Object|null} 200.window - Fees and dates, when a window exists
   * @returns {string|null} 200.reason - Why it is shut: no_window | not_yet_open | period_ended | at_capacity
   * @returns {Object|null} 200.last_window - The previous intake's dates, for context when nothing is scheduled
   */
  .get("/window", async () => {
    const state = await getActiveWindow();

    if (!state.window) {
      const last = await getLastClosedWindow();
      return {
        is_open: false,
        reason: state.reason,
        window: null,
        last_window: last
          ? { name: last.name, opens_at: last.opens_at, closes_at: last.closes_at }
          : null,
      };
    }

    return {
      is_open: state.is_open,
      reason: state.reason,
      window: publicWindow(state.window, state.slots_remaining),
      last_window: null,
    };
  })

  /**
   * Pre-flight an application, before payment
   *
   * The apply endpoint takes payment first so no unpaid account can exist. The
   * price of that is a rejection landing after the applicant has already been
   * charged. This runs the cheap rejections — window shut, email already
   * registered, subscription out of range — against an unpaid draft, so the
   * client can stop before checkout.
   *
   * Passing here is not a reservation: the window can still close, or the
   * email be taken, in the seconds between this and the charge. Apply
   * re-checks everything.
   *
   * @route POST /registration/precheck
   * @group Registration
   * @returns {Object} 200 - { ok: true }
   * @returns {Error} 403 - Registration is not open
   * @returns {Error} 409 - Email already registered
   * @returns {Error} 422 - Subscription out of range
   */
  .post(
    "/precheck",
    async ({ body, set }) => {
      try {
        await precheckApplication(body);
        return { ok: true };
      } catch (err) {
        if (err instanceof RegistrationClosedError) {
          set.status = 403;
          return { error: err.message, reason: err.reason };
        }
        if (err instanceof RegistrationError) {
          set.status = err.status;
          return { error: err.message, reason: err.code };
        }
        throw err;
      }
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        monthly_subscription: t.Optional(t.Number({ minimum: 0 })),
      }),
    },
  )

  /**
   * Submit a membership application
   *
   * Takes the completed MEM form plus the Paystack reference for the
   * registration and social fees. The payment is re-verified server-side
   * against Paystack before any account exists, so a forged reference costs
   * nothing but a rejection.
   *
   * On success the member exists with `status = 'pending'` and can sign in,
   * but stays unapproved until an admin approves them.
   *
   * @route POST /registration/apply
   * @group Registration
   * @returns {Object} 200 - user_id, email, member_status
   * @returns {Error} 403 - Registration is not open (body carries `reason`)
   * @returns {Error} 402 - Payment could not be confirmed
   * @returns {Error} 409 - Payment reference already used
   * @returns {Error} 422 - Amount mismatch or subscription out of range
   */
  .post(
    "/apply",
    async ({ body, set }) => {
      try {
        return await registerMember(body);
      } catch (err) {
        if (err instanceof RegistrationClosedError) {
          set.status = 403;
          return { error: err.message, reason: err.reason };
        }
        if (err instanceof RegistrationError) {
          set.status = err.status;
          return { error: err.message, reason: err.code };
        }
        throw err;
      }
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 8 }),
        full_name: t.String({ minLength: 2 }),
        sex: t.Optional(t.String()),
        date_of_birth: t.Optional(t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
        phone: t.String({ minLength: 7 }),
        whatsapp_number: t.Optional(t.String()),
        marital_status: t.Optional(t.String()),
        address: t.String({ minLength: 5 }),
        id_card_number: t.Optional(t.String()),
        next_of_kin: t.Optional(t.String()),
        place_of_work: t.Optional(t.String()),
        type_of_business: t.Optional(t.String()),
        bank_name: t.String(),
        bank_account: t.String({ minLength: 10 }),
        bank_code: t.String(),
        referred_by: t.Optional(t.String()),
        monthly_subscription: t.Optional(t.Number({ minimum: 0 })),
        avatar_url: t.Optional(t.String()),
        signature: t.Optional(t.String()),
        payment_reference: t.String({ minLength: 6 }),
      }),
    },
  )

  // ==========================================================================
  // Admin
  // ==========================================================================
  .use(authenticate)
  .use(requireAdmin)

  /** @route GET /registration/windows — every intake, newest first */
  .get("/windows", async () => {
    const { data, error } = await supabase
      .from("registration_windows")
      .select("*")
      .order("opens_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  })

  /**
   * Create an intake
   *
   * Created as a draft. A draft is invisible to applicants until it is opened,
   * which lets the fees and dates be reviewed before anybody can pay against
   * them. Only one window may be non-closed at a time (enforced by a unique
   * partial index), so close the current one first.
   *
   * @route POST /registration/windows
   */
  .post(
    "/windows",
    async ({ body, userId, set }) => {
      const { data, error } = await supabase
        .from("registration_windows")
        .insert({
          name: body.name,
          opens_at: body.opens_at,
          closes_at: body.closes_at,
          capacity: body.capacity ?? null,
          registration_fee: body.registration_fee ?? 20000,
          social_fee: body.social_fee ?? 1000,
          min_monthly_subscription: body.min_monthly_subscription ?? 5000,
          max_monthly_subscription: body.max_monthly_subscription ?? 50000,
          created_by: userId!,
        })
        .select("*")
        .single();

      if (error) {
        // 23505 on the partial unique index: another intake is still live.
        if (error.code === "23505") {
          set.status = 409;
          return {
            error:
              "Another registration window is still open or in draft. Close it before creating a new one.",
          };
        }
        throw new Error(error.message);
      }

      await writeAuditLog({
        actor_id: userId!,
        action: "create_registration_window",
        entity: "registration_windows",
        entity_id: data.id,
        metadata: { name: data.name, opens_at: data.opens_at, closes_at: data.closes_at },
      });

      return data;
    },
    {
      body: t.Object({
        name: t.String({ minLength: 2 }),
        opens_at: t.String(),
        closes_at: t.String(),
        capacity: t.Optional(t.Nullable(t.Number({ minimum: 1 }))),
        registration_fee: t.Optional(t.Number({ minimum: 0 })),
        social_fee: t.Optional(t.Number({ minimum: 0 })),
        min_monthly_subscription: t.Optional(t.Number({ minimum: 1 })),
        max_monthly_subscription: t.Optional(t.Number({ minimum: 1 })),
      }),
    },
  )

  /**
   * Amend an intake
   *
   * `state` is not editable here — use /open and /close, which record why.
   *
   * @route PATCH /registration/windows/:id
   */
  .patch(
    "/windows/:id",
    async ({ params, body, userId, set }) => {
      // Built field by field rather than by filtering Object.entries: `capacity`
      // is legitimately nullable, so "omitted" and "explicitly cleared" are
      // different intents and a generic truthiness filter would conflate them.
      const patch: Database["public"]["Tables"]["registration_windows"]["Update"] = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.opens_at !== undefined) patch.opens_at = body.opens_at;
      if (body.closes_at !== undefined) patch.closes_at = body.closes_at;
      if (body.capacity !== undefined) patch.capacity = body.capacity;
      if (body.registration_fee !== undefined) patch.registration_fee = body.registration_fee;
      if (body.social_fee !== undefined) patch.social_fee = body.social_fee;
      if (body.min_monthly_subscription !== undefined)
        patch.min_monthly_subscription = body.min_monthly_subscription;
      if (body.max_monthly_subscription !== undefined)
        patch.max_monthly_subscription = body.max_monthly_subscription;

      if (Object.keys(patch).length === 0) {
        set.status = 400;
        return { error: "No fields to update" };
      }

      const { data, error } = await supabase
        .from("registration_windows")
        .update(patch)
        .eq("id", params.id)
        .select("*")
        .single();

      if (error) throw new Error(error.message);

      await writeAuditLog({
        actor_id: userId!,
        action: "update_registration_window",
        entity: "registration_windows",
        entity_id: params.id,
        metadata: patch as Record<string, unknown>,
      });

      return data;
    },
    {
      params: uuidParam,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 2 })),
        opens_at: t.Optional(t.String()),
        closes_at: t.Optional(t.String()),
        capacity: t.Optional(t.Nullable(t.Number({ minimum: 1 }))),
        registration_fee: t.Optional(t.Number({ minimum: 0 })),
        social_fee: t.Optional(t.Number({ minimum: 0 })),
        min_monthly_subscription: t.Optional(t.Number({ minimum: 1 })),
        max_monthly_subscription: t.Optional(t.Number({ minimum: 1 })),
      }),
    },
  )

  /**
   * Open the portal
   *
   * Flips the manual override to 'open'. The window still only accepts
   * applications inside [opens_at, closes_at] and below capacity — opening a
   * window whose period has not started does not let anyone in early.
   *
   * @route POST /registration/windows/:id/open
   */
  .post(
    "/windows/:id/open",
    async ({ params, userId, set }) => {
      const { data, error } = await supabase
        .from("registration_windows")
        .update({ state: "open" })
        .eq("id", params.id)
        .neq("state", "closed")
        .select("*")
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!data) {
        set.status = 409;
        return {
          error:
            "A closed window cannot be reopened. Create a new intake instead, so each intake keeps its own fees and applicants.",
        };
      }

      await writeAuditLog({
        actor_id: userId!,
        action: "open_registration_window",
        entity: "registration_windows",
        entity_id: params.id,
        metadata: { name: data.name },
      });

      return data;
    },
    { params: uuidParam },
  )

  /**
   * Close the portal
   *
   * Terminal: a closed window is history and cannot be reopened, so the
   * applicants and fees of each intake stay attributable to it.
   *
   * @route POST /registration/windows/:id/close
   */
  .post(
    "/windows/:id/close",
    async ({ params, userId }) => {
      const { data, error } = await supabase
        .from("registration_windows")
        .update({ state: "closed" })
        .eq("id", params.id)
        .select("*")
        .single();

      if (error) throw new Error(error.message);

      await writeAuditLog({
        actor_id: userId!,
        action: "close_registration_window",
        entity: "registration_windows",
        entity_id: params.id,
        metadata: { name: data.name, applications_count: data.applications_count },
      });

      return data;
    },
    { params: uuidParam },
  )

  /**
   * Applicants of one intake
   *
   * Signature paths are exchanged for short-lived signed URLs here rather than
   * returned raw — the bucket is private, so a bare path is useless to the
   * admin client and a permanent URL would defeat the point.
   *
   * @route GET /registration/windows/:id/applications
   */
  .get(
    "/windows/:id/applications",
    async ({ params }) => {
      const { data, error } = await supabase
        .from("profiles")
        // One literal, not a concatenation: the PostgREST types are inferred
        // from the string's literal type, which `+` erases.
        .select(
          "id, full_name, email, phone, whatsapp_number, sex, date_of_birth, marital_status, address, id_card_number, next_of_kin, place_of_work, type_of_business, referred_by, bank_name, bank_account, monthly_subscription, signature_url, member_no, status, registration_fee_paid, registration_paid_at, registration_ref, created_at",
        )
        .eq("registration_window_id", params.id)
        .order("created_at", { ascending: false });

      if (error) throw new Error(error.message);

      return Promise.all(
        (data ?? []).map(async (row) => ({
          ...row,
          signature_url: row.signature_url
            ? await signedSignatureUrl(row.signature_url)
            : null,
        })),
      );
    },
    { params: uuidParam },
  );
