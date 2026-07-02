/**
 * Notification Service
 *
 * Handles all notification delivery via Expo Push API and WebSocket broadcasting.
 * Supports batch sending, delivery tracking, and user preferences.
 *
 * `notify()` is the single entry point for domain events: it persists to the
 * `notifications` inbox, publishes to per-user WebSocket channels (and the
 * admin channel), sends Expo push, and logs delivery — in one call.
 *
 * @module services/notificationService
 * @requires expo-server-sdk
 * @requires supabase
 *
 * @example
 * ```typescript
 * import { NotificationService } from './services/notificationService';
 *
 * const service = NotificationService.getInstance();
 *
 * await service.notify({
 *   userIds: ['user-id-1'],
 *   type: 'loan',
 *   title: 'Loan Approved',
 *   body: 'Your loan has been approved!',
 *   data: { event: 'loan_approved', loan_id: 'loan-789' },
 *   action: { label: 'View Details', url: '/loans/loan-789' },
 * });
 * ```
 */

import { Expo, ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import type { Elysia } from "elysia";
import { supabase } from "../lib/supabase";
import type { Database } from "../types/database";

type Json = Database["public"]["Tables"]["notification_logs"]["Row"]["data"];
type NotificationRow = Database["public"]["Tables"]["notifications"]["Row"];

/** The running Bun server, as typed by Elysia (`app.server` after listen()) */
type BunServer = NonNullable<Elysia["server"]>;

/**
 * Canonical notification type — matches the `notifications.type` CHECK
 * constraint and the REST contract enum. Event subtypes (e.g.
 * "loan_disbursed") belong in `data.event`.
 */
export type NotificationType =
  | "loan"
  | "contribution"
  | "dividend"
  | "security"
  | "meeting";

export const NOTIFICATION_TYPES: NotificationType[] = [
  "loan",
  "contribution",
  "dividend",
  "security",
  "meeting",
];

/** Optional CTA attached to a notification; url is an in-app expo-router path */
export interface NotificationAction {
  label: string;
  url: string;
}

/** Notification as serialized on the wire (REST responses and WS frames) */
export interface WireNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
  action: NotificationAction | null;
  data: Record<string, unknown>;
}

const WIRE_ID_PREFIX = "ntf_";

/** Wire ids are the DB uuid with an `ntf_` prefix */
export function toWireId(id: string): string {
  return `${WIRE_ID_PREFIX}${id}`;
}

/** Accepts both prefixed wire ids and raw uuids */
export function fromWireId(id: string): string {
  return id.startsWith(WIRE_ID_PREFIX) ? id.slice(WIRE_ID_PREFIX.length) : id;
}

/** Map a `notifications` row to the REST contract wire object */
export function serializeNotification(row: NotificationRow): WireNotification {
  return {
    id: toWireId(row.id),
    type: row.type,
    title: row.title,
    body: row.body,
    read: row.read,
    created_at: new Date(row.created_at).toISOString(),
    action: (row.action as NotificationAction | null) ?? null,
    data: (row.data as Record<string, unknown> | null) ?? {},
  };
}

/**
 * Options for the unified notify() dispatcher
 */
export interface NotifyOptions {
  /** Target member IDs (may be empty for admin-only notifications) */
  userIds: string[];
  /** Canonical notification type (drives inbox `type` and preference gating) */
  type: NotificationType;
  title: string;
  body: string;
  /** Extra data carried on WS frames and inbox rows */
  data?: Record<string, unknown>;
  /** CTA shown by clients; url must be an in-app expo-router path */
  action?: NotificationAction;
  /** Also publish one frame to the admin-notifications WS channel */
  notifyAdmins?: boolean;
  /** Also send Expo push to all admins */
  pushAdmins?: boolean;
  /** Send Expo push to userIds (default true; preferences still apply) */
  push?: boolean;
}

/**
 * Target specification for notifications
 */
export interface NotificationTarget {
  /** Specific user IDs to notify */
  userIds?: string[];
  /** Target users by role */
  role?: "admin" | "member";
  /** Send to all active users */
  all?: boolean;
}

/**
 * User notification preferences (REST contract shape).
 * `security` is server-enforced always-true and has no DB column.
 */
export interface NotificationPreferences {
  push_enabled: boolean;
  categories: {
    loan: boolean;
    contribution: boolean;
    dividend: boolean;
    security: true;
    meeting: boolean;
  };
}

/** Maps canonical type → preference column; `security` is never filtered */
const PREFERENCE_COLUMN: Partial<Record<NotificationType, string>> = {
  loan: "loan_enabled",
  contribution: "contribution_enabled",
  dividend: "dividend_enabled",
  meeting: "meeting_enabled",
};

/** A push recipient; notificationId links the push back to the inbox row */
interface PushRecipient {
  userId: string;
  notificationId?: string | null;
}

/** Push content shared by all recipients of one notify() call */
interface PushPayload {
  title: string;
  body: string;
  type: NotificationType;
  url?: string | null;
}

/**
 * Singleton service for managing notifications
 */
export class NotificationService {
  private static instance: NotificationService;
  private expo: Expo;
  private batchSize: number = 500;
  private server: BunServer | null = null;

  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {
    const accessToken = process.env.EXPO_ACCESS_TOKEN;

    if (!accessToken) {
      console.warn("EXPO_ACCESS_TOKEN not set. Push notifications will not work.");
    }

    this.expo = new Expo({ accessToken });
  }

  /**
   * Get the singleton instance of NotificationService
   * @returns {NotificationService} The service instance
   */
  static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  /**
   * Attach the running Bun server so the service can publish to WebSocket
   * topics. Called once from index.ts after listen().
   */
  setServer(server: BunServer): void {
    this.server = server;
  }

  /**
   * Publish a message to a Bun pub/sub topic. No-op until setServer() is
   * called. In-process only — horizontal scaling would need a shared broker.
   */
  private publish(topic: string, message: object): void {
    try {
      this.server?.publish(topic, JSON.stringify(message));
    } catch (error) {
      console.error(`Error publishing to ${topic}:`, error);
    }
  }

  /**
   * Unified notification dispatch: inbox insert + WebSocket publish + Expo
   * push + delivery logging. Preferences gate push only — the inbox row and
   * WS frame are always delivered so in-app history stays complete.
   *
   * @returns Number of inbox notifications created
   */
  async notify(opts: NotifyOptions): Promise<{ delivered: number }> {
    const { userIds, type, title, body, data = {}, action, push = true } = opts;
    const timestamp = new Date().toISOString();

    // Insert inbox rows (returning ids so WS frames can reference them)
    let inserted: { id: string; member_id: string }[] = [];
    if (userIds.length) {
      const { data: rows, error } = await supabase
        .from("notifications")
        .insert(
          userIds.map((member_id) => ({
            member_id,
            title,
            body,
            type,
            data: data as Json,
            action: (action ?? null) as Json,
          })),
        )
        .select("id, member_id");

      if (error) {
        console.error("Error inserting notifications:", error);
      } else {
        inserted = rows ?? [];
      }
    }

    // WebSocket publish to each user's personal channel
    for (const userId of userIds) {
      const row = inserted.find((r) => r.member_id === userId);
      this.publish(`user-${userId}`, {
        type: "notification",
        id: row ? toWireId(row.id) : null,
        notification_type: type,
        title,
        body,
        data,
        action: action ?? null,
        timestamp,
      });
    }

    // Admin dashboard channel
    if (opts.notifyAdmins) {
      this.publish("admin-notifications", {
        type: "notification",
        notification_type: type,
        title,
        body,
        data,
        action: action ?? null,
        timestamp,
      });
    }

    // Log WebSocket deliveries (best effort)
    if (userIds.length) {
      const { error } = await supabase.from("notification_logs").insert(
        userIds.map((recipient_id) => ({
          recipient_id,
          type,
          channel: "websocket",
          title,
          body,
          data: data as Json,
          status: "sent",
        })),
      );
      if (error) console.error("Error logging websocket notifications:", error);
    }

    const pushPayload: PushPayload = { title, body, type, url: action?.url ?? null };

    // Expo push (preference-gated)
    if (push && userIds.length) {
      const pushTargets = await this.filterByPreference(userIds, type);
      if (pushTargets.length) {
        await this.sendPushNotifications(
          pushTargets.map((userId) => ({
            userId,
            notificationId: inserted.find((r) => r.member_id === userId)?.id ?? null,
          })),
          pushPayload,
        );
      }
    }

    if (opts.pushAdmins) {
      const adminIds = await this.getTargetUserIds({ role: "admin", all: true });
      const targets = adminIds.filter((id) => !userIds.includes(id));
      if (targets.length) {
        await this.sendPushNotifications(
          targets.map((userId) => ({ userId })),
          pushPayload,
        );
      }
    }

    return { delivered: inserted.length };
  }

  /**
   * Filter user IDs down to those who should receive push for this type.
   * `push_enabled` is the master switch; category toggles apply per type
   * except `security`, which can never be muted individually. Missing
   * preference rows count as enabled.
   */
  private async filterByPreference(
    userIds: string[],
    type: NotificationType,
  ): Promise<string[]> {
    const column = PREFERENCE_COLUMN[type];
    const columns = ["member_id", "push_enabled", ...(column ? [column] : [])];

    const { data, error } = await supabase
      .from("notification_preferences")
      .select(columns.join(", "))
      .in("member_id", userIds);

    if (error || !data) {
      if (error) console.error("Error fetching preferences:", error);
      return userIds;
    }

    const disabled = new Set(
      (data as unknown as Record<string, unknown>[])
        .filter(
          (row) =>
            row.push_enabled === false || (column ? row[column] === false : false),
        )
        .map((row) => row.member_id as string),
    );

    return userIds.filter((id) => !disabled.has(id));
  }

  /**
   * Send push notifications to mobile devices via Expo.
   *
   * Reads tokens from `notification_devices` (multiple devices per user),
   * attaches per-user badge counts, and includes `{ url, notification_id,
   * type }` in the data payload per the REST contract. Tokens Expo reports
   * as DeviceNotRegistered are pruned from the registry.
   */
  async sendPushNotifications(
    recipients: PushRecipient[],
    payload: PushPayload,
  ): Promise<void> {
    if (!recipients.length) return;

    try {
      const userIds = recipients.map((r) => r.userId);

      const { data: devices, error } = await supabase
        .from("notification_devices")
        .select("member_id, token")
        .in("member_id", userIds);

      if (error) {
        console.error("Error fetching devices for push:", error);
        return;
      }

      const validDevices = (devices ?? []).filter((d) => Expo.isExpoPushToken(d.token));

      if (!validDevices.length) {
        console.log("No valid Expo tokens found for users:", userIds);
        return;
      }

      const badges = await this.getUnreadCounts(userIds);
      const byUser = new Map(recipients.map((r) => [r.userId, r]));

      // Prepare messages (one per device)
      const messages: ExpoPushMessage[] = validDevices.map((device) => {
        const recipient = byUser.get(device.member_id);
        return {
          to: device.token,
          sound: "default",
          title: payload.title,
          body: payload.body,
          data: {
            url: payload.url ?? null,
            notification_id: recipient?.notificationId
              ? toWireId(recipient.notificationId)
              : null,
            type: payload.type,
          },
          channelId: "default",
          badge: badges.get(device.member_id),
          priority: "high",
        };
      });

      // Chunk in batches of 500
      const chunks = this.chunk(messages, this.batchSize);
      const deviceChunks = this.chunk(validDevices, this.batchSize);

      for (let i = 0; i < chunks.length; i++) {
        try {
          const tickets = await this.expo.sendPushNotificationsAsync(chunks[i]);
          await this.logTickets(deviceChunks[i], tickets, payload, "push");
          await this.pruneDeadDevices(deviceChunks[i], tickets);

          console.log(`Sent ${chunks[i].length} push notifications`);
        } catch (error) {
          console.error("Error sending push notification chunk:", error);
        }
      }
    } catch (error) {
      console.error("Error in sendPushNotifications:", error);
    }
  }

  /**
   * Unread inbox counts per user (used as push badge numbers). Falls back to
   * an empty map — badge omitted — if the RPC is unavailable.
   */
  private async getUnreadCounts(userIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    try {
      const { data, error } = await supabase.rpc("unread_notification_counts", {
        user_ids: userIds,
      });
      if (error) {
        console.error("Error fetching unread counts:", error);
        return counts;
      }
      for (const row of data ?? []) {
        counts.set(row.member_id, Number(row.unread));
      }
    } catch (error) {
      console.error("Error fetching unread counts:", error);
    }
    return counts;
  }

  /** Remove device rows whose tokens Expo reports as no longer registered */
  private async pruneDeadDevices(
    devices: { token: string }[],
    tickets: ExpoPushTicket[],
  ): Promise<void> {
    const deadTokens = tickets
      .map((ticket, i) =>
        ticket.status === "error" &&
        ticket.details?.error === "DeviceNotRegistered"
          ? devices[i]?.token
          : null,
      )
      .filter((t): t is string => Boolean(t));

    if (!deadTokens.length) return;

    const { error } = await supabase
      .from("notification_devices")
      .delete()
      .in("token", deadTokens);
    if (error) console.error("Error pruning dead devices:", error);
  }

  /**
   * Broadcast notification to all connected admin dashboard clients via WebSocket
   */
  broadcastToAdmins(payload: { title: string; body: string; data?: Record<string, unknown> }): void {
    this.publish("admin-notifications", {
      type: "notification",
      timestamp: new Date().toISOString(),
      ...payload,
    });
  }

  /**
   * Send notification to specific user via WebSocket (for real-time updates)
   */
  sendToUser(userId: string, payload: { title: string; body: string; data?: Record<string, unknown> }): void {
    this.publish(`user-${userId}`, {
      type: "notification",
      timestamp: new Date().toISOString(),
      ...payload,
    });
  }

  /**
   * Get notification preferences for a user in the REST contract shape.
   * Missing rows return the defaults (everything enabled).
   */
  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const { data } = await supabase
      .from("notification_preferences")
      .select("push_enabled, loan_enabled, contribution_enabled, dividend_enabled, meeting_enabled")
      .eq("member_id", userId)
      .maybeSingle();

    return {
      push_enabled: data?.push_enabled ?? true,
      categories: {
        loan: data?.loan_enabled ?? true,
        contribution: data?.contribution_enabled ?? true,
        dividend: data?.dividend_enabled ?? true,
        security: true,
        meeting: data?.meeting_enabled ?? true,
      },
    };
  }

  /**
   * Get target user IDs based on criteria
   *
   * @param {NotificationTarget} target - Target specification
   * @returns {Promise<string[]>} Array of user IDs
   */
  async getTargetUserIds(target: NotificationTarget): Promise<string[]> {
    if (target.userIds?.length) {
      return target.userIds;
    }

    let query = supabase.from("profiles").select("id");

    if (target.role) {
      query = query.eq("role", target.role);
    }

    if (!target.all) {
      // If not "all", default to only active members
      query = query.eq("status", "active");
    }

    const { data, error } = await query;

    if (error) {
      console.error("Error fetching target users:", error);
      return [];
    }

    return data?.map((p) => p.id) || [];
  }

  /**
   * Chunk array into smaller arrays
   *
   * @private
   * @param {T[]} array - Array to chunk
   * @param {number} size - Chunk size (default: 500)
   * @returns {T[][]} Array of chunks
   */
  private chunk<T>(array: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
      array.slice(i * size, i * size + size),
    );
  }

  /**
   * Log push delivery tickets to notification_logs
   *
   * @private
   */
  private async logTickets(
    devices: { member_id: string }[],
    tickets: ExpoPushTicket[],
    payload: PushPayload,
    channel: string,
  ): Promise<void> {
    const logs = tickets.map((ticket, i) => ({
      recipient_id: devices[i]?.member_id,
      type: payload.type,
      channel,
      title: payload.title,
      body: payload.body,
      data: { url: payload.url ?? null } as Json,
      status: ticket.status === "ok" ? "sent" : "failed",
      error_message: ticket.status === "error" ? ticket.message : null,
    }));

    const { error } = await supabase.from("notification_logs").insert(logs);

    if (error) {
      console.error("Error logging notifications:", error);
    }
  }
}

/**
 * Convenience function to get notification service instance
 * @returns {NotificationService} The singleton instance
 */
export const getNotificationService = (): NotificationService => {
  return NotificationService.getInstance();
};
