import Elysia from "elysia";
import { supabaseAuth } from "../lib/supabase";

const PUBLIC_PATHS = [
  "/v1/banks",
  "/v1/auth/login",
  "/v1/auth/register",
  "/v1/auth/reset-password",
  "/v1/auth/confirm-reset",
  "/v1/auth/resend-verification",
  "/v1/auth/refresh",
  "/v1/webhooks/paystack",
  "/banks",
  "/auth/login",
  "/auth/register",
  "/auth/reset-password",
  "/auth/confirm-reset",
  "/auth/resend-verification",
  "/auth/refresh",
  "/webhooks/paystack",
];

export const authenticate = new Elysia({ name: "authenticate" }).derive(
  { as: "global" },
  async ({ headers, set, path }) => {
    if (PUBLIC_PATHS.some((p) => path.startsWith(p))) {
      return;
    }

    const authHeader = headers["authorization"];
    if (!authHeader?.startsWith("Bearer ")) {
      set.status = 401;
      throw new Error("Missing or malformed Authorization header");
    }
    const token = authHeader.replace("Bearer ", "").trim();
    const {
      data: { user },
      error,
    } = await supabaseAuth.auth.getUser(token);
    if (error || !user) {
      set.status = 401;
      throw new Error("Invalid or expired token");
    }

    return {
      user,
      role: (user.app_metadata?.user_role as string) ?? "member",
      userId: user.id,
      token,
    };
  },
);
