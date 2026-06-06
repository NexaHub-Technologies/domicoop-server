import Elysia, { t } from "elysia";
import { authenticate } from "@/middleware/authenticate";
import { requireAdmin } from "@/middleware/requireAdmin";
import { supabase } from "@/lib/supabase";
import {
  NotificationService,
  NotificationPayload,
} from "@/services/notificationService";

const notificationService = NotificationService.getInstance();

/**
 * Notification Routes
 *
 * Handles user notifications and admin broadcasting.
 * Uses Expo Push Notifications for mobile delivery.
 *
 * @route /notifications
 */
export const notificationRoutes = new Elysia({ prefix: "/notifications" })
  .use(authenticate)

  // Get user notifications
  .get(
    "/me",
    async ({ userId, query }) => {
      let q = supabase
        .from("notifications")
        .select("*")
        .eq("member_id", userId!)
        .order("created_at", { ascending: false })
        .limit(50);

      if (query.unread_only) q = q.eq("read", false);

      const { data, error } = await q;
      if (error) throw new Error(error.message);

      const unread_count = data?.filter((n) => !n.read).length ?? 0;
      return { notifications: data, unread_count };
    },
    { query: t.Partial(t.Object({ unread_only: t.Boolean() })) }
  )

  // Mark notification(s) as read
  .patch(
    "/me/read",
    async ({ userId, body }) => {
      let q = supabase
        .from("notifications")
        .update({ read: true })
        .eq("member_id", userId!);

      if (body.id) q = q.eq("id", body.id);
      // If no id provided, mark all as read

      await q;
      return { success: true };
    },
    { body: t.Partial(t.Object({ id: t.String() })) }
  )

  // Get notification preferences
  .get("/preferences", async ({ userId }) => {
    const prefs = await notificationService.getPreferences(userId!);
    return prefs;
  })

  // Update notification preferences
  .patch(
    "/preferences",
    async ({ userId, body }) => {
      const updateData: any = {
        member_id: userId,
        updated_at: new Date().toISOString(),
      };

      if (body.payments_enabled !== undefined)
        updateData.payments_enabled = body.payments_enabled;
      if (body.loans_enabled !== undefined)
        updateData.loans_enabled = body.loans_enabled;
      if (body.announcements_enabled !== undefined)
        updateData.announcements_enabled = body.announcements_enabled;
      if (body.messages_enabled !== undefined)
        updateData.messages_enabled = body.messages_enabled;

      await supabase
        .from("notification_preferences")
        .upsert(updateData, { onConflict: "member_id" });

      return { success: true };
    },
    {
      body: t.Object({
        payments_enabled: t.Optional(t.Boolean()),
        loans_enabled: t.Optional(t.Boolean()),
        announcements_enabled: t.Optional(t.Boolean()),
        messages_enabled: t.Optional(t.Boolean()),
      }),
    }
  )

  // Admin broadcast
  .use(requireAdmin)
  .post(
    "/broadcast",
    async ({ body, store }) => {
      // Fetch target members
      let query = supabase
        .from("profiles")
        .select("id, expo_push_token")
        .eq("status", "active")
        .not("expo_push_token", "is", null);

      if (body.member_ids?.length) {
        query = query.in("id", body.member_ids);
      }

      const { data: members } = await query;
      const targets = members || [];

      // Persist notification to DB
      if (targets.length) {
        await supabase.from("notifications").insert(
          targets.map((m) => ({
            member_id: m.id,
            title: body.title,
            body: body.body,
            type: body.type ?? "general",
            data: body.data ?? {},
          }))
        );
      }

      // Send Expo Push notifications
      const userIds = targets.map((m) => m.id);
      if (userIds.length) {
        await notificationService.sendPushNotifications(userIds, {
          title: body.title,
          body: body.body,
          data: { type: body.type, ...body.data },
        });
      }

      // Broadcast to admin dashboard via WebSocket
      // @ts-ignore
      notificationService.broadcastToAdmins(store.server, {
        title: body.title,
        body: body.body,
        data: { type: body.type, recipientCount: targets.length },
      });

      return { sent: targets.length };
    },
    {
      body: t.Object({
        title: t.String(),
        body: t.String(),
        type: t.Optional(
          t.Union([
            t.Literal("payment"),
            t.Literal("loan"),
            t.Literal("announcement"),
            t.Literal("message"),
            t.Literal("general"),
          ])
        ),
        member_ids: t.Optional(t.Array(t.String())),
        data: t.Optional(t.Record(t.String(), t.String())),
      }),
    }
  );
