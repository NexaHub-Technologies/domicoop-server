/**
 * WebSocket Routes for Real-time Notifications
 *
 * Provides WebSocket connections for:
 * - Admin dashboard real-time updates
 * - User-specific notifications
 * - Bidirectional communication (optional)
 *
 * @module routes/websocket
 * @requires Elysia
 * @requires supabaseAuth
 */

import { Elysia, t } from "elysia";
import { supabaseAuth } from "../lib/supabase";
import type { User } from "@supabase/supabase-js";

/**
 * WebSocket message types
 */
type WebSocketMessage =
  | { type: "auth"; token: string }
  | { type: "ping" }
  | { type: "pong" }
  | { type: "notification"; payload: any }
  | { type: "ack"; id: string };

/**
 * WebSocket route definitions
 *
 * @route /ws/notifications
 */
export const websocketRoutes = new Elysia().ws("/ws/notifications", {
  /**
   * Validate connection before upgrade
   *
   * Checks Authorization header for JWT token
   */
  async beforeHandle({ headers, set }) {
    const authHeader = headers["authorization"];
    if (!authHeader?.startsWith("Bearer ")) {
      set.status = 401;
      return "Missing or invalid authorization header";
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const { data, error } = await supabaseAuth.auth.getUser(token);

    if (error || !data.user) {
      set.status = 401;
      return "Invalid or expired token";
    }

    // Store user data for the connection
    return { user: data.user };
  },

  /**
   * Handle new WebSocket connection
   *
   * Subscribes client to appropriate channels based on role
   */
  open(ws) {
    const user = (ws.data as unknown as { user: User }).user;
    const role = user.app_metadata?.user_role || "member";

    console.log(`[WebSocket] Connected: ${user.email} (${role})`);

    // Subscribe to channels based on role
    if (role === "admin") {
      // Admins get admin-notifications channel
      ws.subscribe("admin-notifications");
      console.log(`[WebSocket] Subscribed admin ${user.email} to admin-notifications`);
    }

    // All users get their personal channel
    ws.subscribe(`user-${user.id}`);
    console.log(`[WebSocket] Subscribed ${user.email} to user-${user.id}`);

    // Send connection confirmation
    ws.send(
      JSON.stringify({
        type: "connected",
        timestamp: new Date().toISOString(),
        channels: role === "admin" ? ["admin-notifications", `user-${user.id}`] : [`user-${user.id}`],
      })
    );
  },

  /**
   * Handle incoming messages
   *
   * Supports ping/pong and acknowledgment messages
   */
  message(ws, message: WebSocketMessage) {
    try {
      switch (message.type) {
        case "ping":
          // Respond with pong
          ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
          break;

        case "ack":
          // Acknowledge receipt of notification
          console.log(`[WebSocket] Acknowledged: ${message.id}`);
          break;

        default:
          console.log(`[WebSocket] Received message type: ${message.type}`);
      }
    } catch (error) {
      console.error("[WebSocket] Error handling message:", error);
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Invalid message format",
        })
      );
    }
  },

  /**
   * Handle connection close
   *
   * Cleanup subscriptions
   */
  close(ws) {
    const user = (ws.data as unknown as { user: User }).user;
    console.log(`[WebSocket] Disconnected: ${user.email}`);

    // Unsubscribe is automatic when connection closes
  },
});

