/**
 * Notification Service
 *
 * Handles all notification delivery via Expo Push API and WebSocket broadcasting.
 * Supports batch sending, delivery tracking, and user preferences.
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
 * // Send push to mobile users
 * await service.sendPushNotifications(
 *   ['user-id-1', 'user-id-2'],
 *   { title: 'Hello', body: 'New notification!' }
 * );
 *
 * // Broadcast to admin dashboard
 * service.broadcastToAdmins(server, {
 *   title: 'New Member',
 *   body: 'A new member has registered'
 * });
 * ```
 */

import { Expo, ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import { Elysia } from "elysia";
import { supabase } from "../lib/supabase";
import type { Database } from "../types/database";

type Json = Database["public"]["Tables"]["notification_logs"]["Row"]["data"];

/**
 * Notification payload structure
 */
export interface NotificationPayload {
  /** Notification title (displayed prominently) */
  title: string;
  /** Notification body text */
  body: string;
  /** Additional data sent with notification (used for deep linking) */
  data?: Record<string, unknown>;
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
 * User notification preferences
 */
export interface NotificationPreferences {
  member_id: string;
  payments_enabled: boolean;
  loans_enabled: boolean;
  announcements_enabled: boolean;
  messages_enabled: boolean;
}

/**
 * Singleton service for managing notifications
 */
export class NotificationService {
  private static instance: NotificationService;
  private expo: Expo;
  private batchSize: number = 500;

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
   * Send push notifications to mobile users via Expo
   *
   * @param {string[]} userIds - Array of user IDs to notify
   * @param {NotificationPayload} payload - Notification content
   * @returns {Promise<void>}
   *
   * @example
   * ```typescript
   * await service.sendPushNotifications(
   *   ['user-123', 'user-456'],
   *   {
   *     title: 'Loan Approved',
   *     body: 'Your loan has been approved!',
   *     data: { type: 'loan', loanId: 'loan-789' }
   *   }
   * );
   * ```
   */
  async sendPushNotifications(
    userIds: string[],
    payload: NotificationPayload,
  ): Promise<void> {
    if (!userIds.length) return;

    try {
      // Get enabled tokens from profiles
      const { data: profiles, error } = await supabase
        .from("profiles")
        .select("id, expo_push_token, push_notifications_enabled")
        .in("id", userIds)
        .not("expo_push_token", "is", null)
        .eq("push_notifications_enabled", true);

      if (error) {
        console.error("Error fetching profiles for push:", error);
        return;
      }

      if (!profiles?.length) {
        console.log("No valid Expo tokens found for users:", userIds);
        return;
      }

      // Prepare messages
      const messages: ExpoPushMessage[] = profiles
        .filter((p) => Expo.isExpoPushToken(p.expo_push_token!))
        .map((p) => ({
          to: p.expo_push_token!,
          sound: "default",
          title: payload.title,
          body: payload.body,
          data: payload.data || {},
          priority: "high",
        }));

      if (!messages.length) {
        console.log("No valid Expo messages to send");
        return;
      }

      // Chunk in batches of 500
      const chunks = this.chunk(messages, this.batchSize);

      for (const chunk of chunks) {
        try {
          const tickets = await this.expo.sendPushNotificationsAsync(chunk);
          await this.logTickets(profiles, tickets, payload, "push");

          // Log success
          console.log(`Sent ${chunk.length} push notifications`);
        } catch (error) {
          console.error("Error sending push notification chunk:", error);
        }
      }
    } catch (error) {
      console.error("Error in sendPushNotifications:", error);
    }
  }

  /**
   * Broadcast notification to all connected admin dashboard clients via WebSocket
   *
   * @param {Elysia} server - Elysia server instance with WebSocket support
   * @param {NotificationPayload} payload - Notification content
   * @returns {void}
   *
   * @example
   * ```typescript
   * service.broadcastToAdmins(server, {
   *   title: 'New Contribution',
   *   body: 'A member has made a new contribution',
   *   data: { contributionId: 'contrib-123' }
   * });
   * ```
   */
  broadcastToAdmins(server: Elysia, payload: NotificationPayload): void {
    try {
      // @ts-ignore - server.publish exists on Elysia with WebSocket
      server?.server?.publish(
        "admin-notifications",
        JSON.stringify({
          type: "notification",
          timestamp: new Date().toISOString(),
          ...payload,
        }),
      );

      console.log("Broadcasted to admin dashboard:", payload.title);
    } catch (error) {
      console.error("Error broadcasting to admins:", error);
    }
  }

  /**
   * Send notification to specific user via WebSocket (for real-time updates)
   *
   * @param {Elysia} server - Elysia server instance
   * @param {string} userId - Target user ID
   * @param {NotificationPayload} payload - Notification content
   * @returns {void}
   */
  sendToUser(server: Elysia, userId: string, payload: NotificationPayload): void {
    try {
      // @ts-ignore
      server?.server?.publish(
        `user-${userId}`,
        JSON.stringify({
          type: "notification",
          timestamp: new Date().toISOString(),
          ...payload,
        }),
      );
    } catch (error) {
      console.error(`Error sending to user ${userId}:`, error);
    }
  }

  /**
   * Get notification preferences for a user
   *
   * @param {string} userId - User ID
   * @returns {Promise<NotificationPreferences>} User preferences
   *
   * @example
   * ```typescript
   * const prefs = await service.getPreferences('user-123');
   * if (prefs.loans_enabled) {
   *   // Send loan notification
   * }
   * ```
   */
  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const { data, error } = await supabase
      .from("notification_preferences")
      .select("*")
      .eq("member_id", userId)
      .single();

    if (error || !data) {
      // Return defaults if not found
      return {
        member_id: userId,
        payments_enabled: true,
        loans_enabled: true,
        announcements_enabled: true,
        messages_enabled: true,
      };
    }

    return data as NotificationPreferences;
  }

  /**
   * Check if user wants notifications for a specific type
   *
   * @param {string} userId - User ID
   * @param {'payments' | 'loans' | 'announcements' | 'messages'} type - Notification type
   * @returns {Promise<boolean>} Whether notifications are enabled
   */
  async isEnabled(
    userId: string,
    type: "payments" | "loans" | "announcements" | "messages",
  ): Promise<boolean> {
    const prefs = await this.getPreferences(userId);
    return prefs[`${type}_enabled` as keyof NotificationPreferences] as boolean;
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
   * Log notification tickets to database
   *
   * @private
   * @param {any[]} profiles - User profiles
   * @param {ExpoPushTicket[]} tickets - Expo push tickets
   * @param {NotificationPayload} payload - Notification content
   * @param {string} channel - Delivery channel
   */
  private async logTickets(
    profiles: any[],
    tickets: ExpoPushTicket[],
    payload: NotificationPayload,
    channel: string,
  ): Promise<void> {
    const logs = tickets.map((ticket, i) => ({
      recipient_id: profiles[i]?.id,
      type: (payload.data?.type as string) || "system",
      channel,
      title: payload.title,
      body: payload.body,
      data: (payload.data || {}) as Json,
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
