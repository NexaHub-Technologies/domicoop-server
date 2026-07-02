/**
 * WebSocket Routes for Real-time Notifications
 *
 * Provides WebSocket connections for:
 * - Admin dashboard real-time updates
 * - User-specific notifications
 *
 * Auth: pass the Supabase access token as `?token=` (browsers cannot set
 * headers on WebSocket connections) or as an `Authorization: Bearer` header.
 *
 * @module routes/websocket
 * @requires Elysia
 * @requires supabaseAuth
 */

import { Elysia, t } from "elysia";
import { supabaseAuth } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";

/**
 * WebSocket message types
 */
type WebSocketMessage =
  | { type: "ping" }
  | { type: "pong" }
  | { type: "ack"; id: string };

/**
 * WebSocket route definitions
 *
 * @route /ws/notifications
 */
export const websocketRoutes = new Elysia().ws("/ws/notifications", {
  query: t.Object({ token: t.Optional(t.String()) }),

  /**
   * Validate connection before upgrade.
   *
   * Accepts the token via `?token=` query param (browser clients) or the
   * Authorization header. On success the user is attached to the context so
   * `open()` can read it from `ws.data` — returning a value here would
   * short-circuit the upgrade, so we mutate instead.
   */
  async beforeHandle(ctx) {
    const { query, headers, set } = ctx;
    const headerToken = headers["authorization"]?.startsWith("Bearer ")
      ? headers["authorization"].replace("Bearer ", "").trim()
      : undefined;
    const token = query.token || headerToken;

    if (!token) {
      set.status = 401;
      return "Missing token (use ?token= or Authorization header)";
    }

    const { data, error } = await supabaseAuth.auth.getUser(token);

    if (error || !data.user) {
      set.status = 401;
      return "Invalid or expired token";
    }

    (ctx as Record<string, unknown>).user = data.user;
    return undefined;
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
        channels:
          role === "admin"
            ? ["admin-notifications", `user-${user.id}`]
            : [`user-${user.id}`],
      })
    );
  },

  /**
   * Handle incoming messages
   *
   * Supports ping/pong and acknowledgment messages
   */
  message(ws, raw) {
    try {
      // Without a body schema Elysia may deliver the raw string
      const message: WebSocketMessage =
        typeof raw === "string" ? JSON.parse(raw) : (raw as WebSocketMessage);

      switch (message.type) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
          break;

        case "ack":
          console.log(`[WebSocket] Acknowledged: ${message.id}`);
          break;

        default:
          console.log(`[WebSocket] Received message type: ${(message as { type: string }).type}`);
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
   * Cleanup subscriptions (automatic on close)
   */
  close(ws) {
    const user = (ws.data as unknown as { user?: User }).user;
    console.log(`[WebSocket] Disconnected: ${user?.email ?? "unknown"}`);
  },
});
