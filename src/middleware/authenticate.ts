import Elysia from "elysia";
import { resolveUserFromToken } from "@/lib/auth";

const PUBLIC_PATHS = [
  "/v1/banks",
  "/v1/auth/login",
  "/v1/auth/register",
  "/v1/auth/reset-password",
  "/v1/auth/confirm-reset",
  "/v1/auth/refresh",
  "/v1/webhooks/paystack",
  // WebSocket route authenticates itself in beforeHandle (browser clients
  // pass the token as ?token= since they cannot set headers)
  "/v1/ws/notifications",
  "/banks",
  "/auth/login",
  "/auth/register",
  "/auth/reset-password",
  "/auth/confirm-reset",
  "/auth/refresh",
  "/webhooks/paystack",
  "/ws/notifications",
];

// Paths that are only public for GET — the same path also serves
// admin-only writes (e.g. POST /announcements creates one), so these need
// an exact + method match rather than a startsWith prefix.
const PUBLIC_GET_PATHS = ["/v1/announcements", "/announcements"];

export const authenticate = new Elysia({ name: "authenticate" }).derive(
  { as: "global" },
  async ({ headers, set, path, request }) => {
    if (PUBLIC_PATHS.some((p) => path.startsWith(p))) {
      return;
    }
    // path can arrive with or without a trailing slash depending on how the
    // client requested it, so compare both forms.
    if (
      request.method === "GET" &&
      PUBLIC_GET_PATHS.some((p) => path === p || path === `${p}/`)
    ) {
      return;
    }

    const authHeader = headers["authorization"];
    if (!authHeader?.startsWith("Bearer ")) {
      set.status = 401;
      throw new Error("Missing or malformed Authorization header");
    }
    const token = authHeader.replace("Bearer ", "").trim();

    const resolved = await resolveUserFromToken(token);
    if (!resolved) {
      set.status = 401;
      throw new Error("Invalid or expired token");
    }

    return { ...resolved, token };
  },
);
