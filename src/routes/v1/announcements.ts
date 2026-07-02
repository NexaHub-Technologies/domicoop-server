import Elysia, { t } from "elysia";
import { authenticate } from "@/middleware/authenticate";
import { requireAdmin } from "@/middleware/requireAdmin";
import { supabase } from "@/lib/supabase";
import { writeAuditLog } from "@/utils/audit";
import { NotificationService } from "@/services/notificationService";

const notificationService = NotificationService.getInstance();

/** Broadcast a newly published announcement to all active members */
async function notifyAnnouncementPublished(announcement: {
  id: string;
  title: string;
  body: string;
}): Promise<void> {
  const userIds = await notificationService.getTargetUserIds({ role: "member" });
  await notificationService.notify({
    userIds,
    type: "meeting",
    title: announcement.title,
    body: announcement.body.slice(0, 120),
    data: { event: "announcement_published", announcement_id: announcement.id },
    action: { label: "View Announcement", url: "/announcements" },
  });
}

export const announcementRoutes = new Elysia({ prefix: "/announcements" })

  // welcome.tsx → GET /announcements (public - latest 3 published)
  .get("/", async () => {
    const { data, error } = await supabase
      .from("announcements")
      .select("id, title, body, created_at")
      .eq("published", true)
      .order("created_at", { ascending: false })
      .limit(3);
    if (error) throw new Error(error.message);
    return data;
  })

  // Admin routes
  .use(authenticate)
  .use(requireAdmin)

  // GET /announcements/all — admin view all
  .get("/all", async () => {
    const { data, error } = await supabase
      .from("announcements")
      .select("*, profiles(full_name)")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  })

  // POST /announcements — create new
  .post(
    "/",
    async ({ body, userId }) => {
      const { data, error } = await supabase
        .from("announcements")
        .insert({
          title: body.title,
          body: body.body,
          author_id: userId!,
          published: body.published ?? false,
        })
        .select()
        .single();
      if (error) throw new Error(error.message);
      await writeAuditLog({
        actor_id: userId!,
        action: "create_announcement",
        entity: "announcements",
        entity_id: data.id,
      });

      if (data.published) {
        await notifyAnnouncementPublished(data);
      }

      return data;
    },
    {
      body: t.Object({
        title: t.String({ minLength: 3 }),
        body: t.String({ minLength: 10 }),
        published: t.Optional(t.Boolean()),
      }),
    },
  )

  // PATCH /announcements/:id — update
  .patch(
    "/:id",
    async ({ params, body, userId }) => {
      // Pre-read so we only broadcast on the unpublished → published transition
      const { data: previous } = await supabase
        .from("announcements")
        .select("published")
        .eq("id", params.id)
        .single();

      const { data, error } = await supabase
        .from("announcements")
        .update({
          ...body,
          updated_at: new Date().toISOString(),
        })
        .eq("id", params.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      await writeAuditLog({
        actor_id: userId!,
        action: "update_announcement",
        entity: "announcements",
        entity_id: params.id,
      });

      if (data.published && previous && !previous.published) {
        await notifyAnnouncementPublished(data);
      }

      return data;
    },
    {
      body: t.Partial(
        t.Object({
          title: t.String({ minLength: 3 }),
          body: t.String({ minLength: 10 }),
          published: t.Boolean(),
        }),
      ),
    },
  )

  // DELETE /announcements/:id
  .delete("/:id", async ({ params, userId }) => {
    const { error } = await supabase.from("announcements").delete().eq("id", params.id);
    if (error) throw new Error(error.message);
    await writeAuditLog({
      actor_id: userId!,
      action: "delete_announcement",
      entity: "announcements",
      entity_id: params.id,
    });
    return { success: true };
  });
