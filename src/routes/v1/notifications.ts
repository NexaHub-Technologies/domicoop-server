import Elysia, { t } from "elysia";
import { authenticate } from "@/middleware/authenticate";
import { requireAdmin } from "@/middleware/requireAdmin";
import { supabase } from "@/lib/supabase";
import {
  NotificationService,
  fromWireId,
  serializeNotification,
} from "@/services/notificationService";

const notificationService = NotificationService.getInstance();

const notificationTypeSchema = t.Union([
  t.Literal("loan"),
  t.Literal("contribution"),
  t.Literal("dividend"),
  t.Literal("security"),
  t.Literal("meeting"),
]);

async function unreadCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("member_id", userId)
    .eq("read", false);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Notification Routes (v2 REST contract)
 *
 * Inbox with pagination + unread meta, per-notification and bulk read state,
 * device (push token) registry, and notification preferences.
 *
 * @route /notifications
 */
export const notificationRoutes = new Elysia({ prefix: "/notifications" })
  .use(authenticate)

  // 1. GET /notifications/me?page&limit — paginated inbox, newest first
  .get(
    "/me",
    async ({ userId, query }) => {
      const page = Math.max(1, query.page ?? 1);
      const limit = Math.min(100, Math.max(1, query.limit ?? 20));
      const from = (page - 1) * limit;

      const [{ data, error, count }, unread_count] = await Promise.all([
        supabase
          .from("notifications")
          .select("*", { count: "exact" })
          .eq("member_id", userId!)
          .order("created_at", { ascending: false })
          .range(from, from + limit - 1),
        unreadCount(userId!),
      ]);
      if (error) throw new Error(error.message);

      const total = count ?? 0;
      return {
        notifications: (data ?? []).map(serializeNotification),
        meta: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit),
          unread_count,
        },
      };
    },
    { query: t.Partial(t.Object({ page: t.Numeric(), limit: t.Numeric() })) },
  )

  // 3. POST /notifications/me/read-all — mark everything read
  .post("/me/read-all", async ({ userId }) => {
    const { error } = await supabase
      .from("notifications")
      .update({ read: true })
      .eq("member_id", userId!)
      .eq("read", false);
    if (error) throw new Error(error.message);
    return { unread_count: 0 };
  })

  // 4. DELETE /notifications/me — clear the inbox
  .delete("/me", async ({ userId }) => {
    const { error } = await supabase
      .from("notifications")
      .delete()
      .eq("member_id", userId!);
    if (error) throw new Error(error.message);
    return new Response(null, { status: 204 });
  })

  // 2. PATCH /notifications/{id}/read — idempotent single-notification read
  .patch("/:id/read", async ({ userId, params, set }) => {
    const id = fromWireId(params.id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      set.status = 404;
      return { error: "Notification not found" };
    }

    const { data, error } = await supabase
      .from("notifications")
      .update({ read: true })
      .eq("id", id)
      .eq("member_id", userId!)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);

    if (!data) {
      set.status = 404;
      return { error: "Notification not found" };
    }

    return {
      notification: serializeNotification(data),
      unread_count: await unreadCount(userId!),
    };
  })

  // 5. POST /notifications/devices — idempotent upsert on token
  .post(
    "/devices",
    async ({ userId, body, set }) => {
      const { data: existing } = await supabase
        .from("notification_devices")
        .select("id")
        .eq("token", body.token)
        .maybeSingle();

      const { error } = await supabase.from("notification_devices").upsert(
        {
          member_id: userId!,
          token: body.token,
          platform: body.platform,
          device_name: body.device_name ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "token" },
      );
      if (error) throw new Error(error.message);

      set.status = existing ? 200 : 201;
      return { success: true };
    },
    {
      body: t.Object({
        token: t.String({ minLength: 1 }),
        platform: t.Union([t.Literal("ios"), t.Literal("android")]),
        device_name: t.Optional(t.String()),
      }),
    },
  )

  // 6. POST /notifications/devices/unregister — POST not DELETE (Expo tokens contain [])
  .post(
    "/devices/unregister",
    async ({ body }) => {
      const { error } = await supabase
        .from("notification_devices")
        .delete()
        .eq("token", body.token);
      if (error) throw new Error(error.message);
      return new Response(null, { status: 204 });
    },
    { body: t.Object({ token: t.String({ minLength: 1 }) }) },
  )

  // 7. GET /notifications/preferences
  .get("/preferences", async ({ userId }) => {
    return notificationService.getPreferences(userId!);
  })

  // 8. PATCH /notifications/preferences — partial update, returns full object;
  //    `security` is server-enforced always-true and cannot be changed
  .patch(
    "/preferences",
    async ({ userId, body }) => {
      const current = await notificationService.getPreferences(userId!);
      const categories = { ...current.categories, ...body.categories };

      const { error } = await supabase.from("notification_preferences").upsert(
        {
          member_id: userId!,
          push_enabled: body.push_enabled ?? current.push_enabled,
          loan_enabled: categories.loan,
          contribution_enabled: categories.contribution,
          dividend_enabled: categories.dividend,
          meeting_enabled: categories.meeting,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "member_id" },
      );
      if (error) throw new Error(error.message);

      return notificationService.getPreferences(userId!);
    },
    {
      body: t.Object({
        push_enabled: t.Optional(t.Boolean()),
        categories: t.Optional(
          t.Partial(
            t.Object({
              loan: t.Boolean(),
              contribution: t.Boolean(),
              dividend: t.Boolean(),
              security: t.Boolean(),
              meeting: t.Boolean(),
            }),
          ),
        ),
      }),
    },
  )

  // Test: send a single push notification directly via Expo API
  .use(requireAdmin)
  .post(
    "/push/test",
    async ({ body, set }) => {
      const expoApiUrl = "https://exp.host/--/api/v2/push/send";

      const payload = {
        to: body.to,
        title: body.title,
        body: body.body,
        data: body.data ?? {},
        sound: body.sound ?? "default",
        priority: body.priority ?? "high",
      };

      const response = await fetch(expoApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.EXPO_ACCESS_TOKEN
            ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
            : {}),
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!response.ok) {
        set.status = response.status;
        throw new Error(result.message ?? "Expo push API error");
      }

      return result;
    },
    {
      body: t.Object({
        to: t.String({ description: "Expo push token (e.g. ExponentPushToken[xxx])" }),
        title: t.String(),
        body: t.String(),
        data: t.Optional(t.Record(t.String(), t.Unknown())),
        sound: t.Optional(t.String()),
        priority: t.Optional(t.Union([t.Literal("default"), t.Literal("normal"), t.Literal("high")])),
      }),
    }
  )

  // Admin broadcast
  .post(
    "/broadcast",
    async ({ body }) => {
      // Fetch target members (no push-token filter — tokenless users still
      // get the inbox row and WebSocket frame)
      let query = supabase
        .from("profiles")
        .select("id")
        .eq("status", "active");

      if (body.member_ids?.length) {
        query = query.in("id", body.member_ids);
      }

      const { data: members } = await query;
      const userIds = (members || []).map((m) => m.id);

      const { delivered } = await notificationService.notify({
        userIds,
        type: body.type ?? "meeting",
        title: body.title,
        body: body.body,
        data: { ...body.data, recipientCount: userIds.length },
        action: body.action,
        notifyAdmins: true,
      });

      return { sent: delivered };
    },
    {
      body: t.Object({
        title: t.String(),
        body: t.String(),
        type: t.Optional(notificationTypeSchema),
        member_ids: t.Optional(t.Array(t.String())),
        data: t.Optional(t.Record(t.String(), t.String())),
        action: t.Optional(t.Object({ label: t.String(), url: t.String() })),
      }),
    }
  );
