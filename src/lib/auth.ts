import { supabaseAuth, supabase } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";

/** Cooperative office an admin holds, if any. Both are needed to approve a loan. */
export type OfficerRole = "secretary" | "president";

export interface ResolvedUser {
  user: User;
  role: "admin" | "member";
  isAdmin: boolean;
  userId: string;
  /**
   * Which office this admin holds, or null. Distinct from `isAdmin`: every
   * officer is an admin, but most admins hold no office and so cannot sign
   * Part C of a loan application.
   */
  officerRole: OfficerRole | null;
}

/**
 * Resolve a Supabase access token to a user and admin status. Shared by the
 * REST `authenticate` middleware and the WebSocket upgrade handler, which
 * can't reuse an Elysia `.derive()` plugin since the ws route isn't part of
 * that request/response cycle.
 */
export async function resolveUserFromToken(token: string): Promise<ResolvedUser | null> {
  const {
    data: { user },
    error,
  } = await supabaseAuth.auth.getUser(token);
  if (error || !user) return null;

  // Admin authorization lives in admin_profiles (see 20260703_admin_profiles_table).
  // A row there is what makes an account an admin; members have none.
  const { data: adminRow } = await supabase
    .from("admin_profiles")
    .select("id, officer_role")
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = !!adminRow;

  return {
    user,
    role: isAdmin ? "admin" : "member",
    isAdmin,
    userId: user.id,
    officerRole: (adminRow?.officer_role as OfficerRole | null) ?? null,
  };
}
