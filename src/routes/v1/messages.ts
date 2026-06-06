import Elysia, { t } from "elysia";
import { authenticate } from "@/middleware/authenticate";
import { requireAdmin } from "@/middleware/requireAdmin";
import { supabase } from "@/lib/supabase";
import { NotificationService } from "@/services/notificationService";

const notificationService = NotificationService.getInstance();

export const messageRoutes = new Elysia({ prefix: "/messages" })
  .use(authenticate)

  // support/index.tsx → GET /messages/me
  .get("/me", async ({ userId }) => {
    const { data, error } = await supabase
      .from("messages")
      .select("*, message_replies(id, body, sender_id, created_at)")
      .eq("member_id", userId!)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  })

  // support/index.tsx → POST /messages (new ticket)
  .post(
    "/",
    async ({ userId, body }) => {
      const { data, error } = await supabase
        .from("messages")
        .insert({ member_id: userId!, subject: body.subject, status: "open" })
        .select()
        .single();
      if (error) throw new Error(error.message);
      await supabase
        .from("message_replies")
        .insert({ message_id: data.id, sender_id: userId!, body: body.body });
      return data;
    },
    {
      body: t.Object({
        subject: t.String({ minLength: 3 }),
        body: t.String({ minLength: 10 }),
      }),
    },
  )

  .post(
    "/:id/reply",
    async ({ params, userId, body, role }) => {
      if (role !== "admin") {
        const { data: thread } = await supabase
          .from("messages")
          .select("member_id")
          .eq("id", params.id)
          .single();
        if (thread?.member_id !== userId)
          throw new Error("Not authorised to reply to this thread");
      }
      const { data, error } = await supabase
        .from("message_replies")
        .insert({ message_id: params.id, sender_id: userId!, body: body.body })
        .select()
        .single();
      if (error) throw new Error(error.message);

      await supabase
        .from("messages")
        .update({
          updated_at: new Date().toISOString(),
          status: role === "admin" ? "in_progress" : "open",
        })
        .eq("id", params.id);

      // Notify the other party via Expo Push
      const { data: thread } = await supabase
        .from("messages")
        .select("member_id")
        .eq("id", params.id)
        .single();
      if (thread && role === "admin") {
        // Send push notification via Expo
        await notificationService.sendPushNotifications([thread.member_id], {
          title: "New reply from admin",
          body: body.body.slice(0, 80),
          data: { type: "message", message_id: params.id },
        });

        // Also persist notification to inbox
        await supabase.from("notifications").insert({
          member_id: thread.member_id,
          title: "New reply from admin",
          body: body.body.slice(0, 80),
          type: "message",
          data: { message_id: params.id },
        });
      }
      return data;
    },
    { body: t.Object({ body: t.String({ minLength: 1 }) }) },
  )

  .use(requireAdmin)

  .get(
    "/",
    async ({ query }) => {
      let q = supabase
        .from("messages")
        .select(
          "*, profiles(full_name, member_no), message_replies(id, body, sender_id, created_at)",
        )
        .order("updated_at", { ascending: false });
      if (query.status) q = q.eq("status", query.status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return data;
    },
    { query: t.Partial(t.Object({ status: t.String() })) },
  )

  .patch(
    "/:id/status",
    async ({ params, body }) => {
      const { data, error } = await supabase
        .from("messages")
        .update({ status: body.status, updated_at: new Date().toISOString() })
        .eq("id", params.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    },
    {
      body: t.Object({
        status: t.Union([
          t.Literal("open"),
          t.Literal("in_progress"),
          t.Literal("resolved"),
          t.Literal("closed"),
        ]),
      }),
    },
  );
