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
  // `select("*")`, not a column list, on purpose.
  //
  // Naming `officer_role` explicitly made admin authorization depend on a
  // column that 20260830000002 adds. Against a database where that migration
  // has not run, PostgREST rejects the whole select, supabase-js returns
  // `data: null`, and the `!!adminRow` below silently demoted EVERY admin to a
  // member — so every admin route answered "Admin access required". A missing
  // optional column must never be able to revoke access.
  const { data: adminRow, error: adminError } = await supabase
    .from("admin_profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  // Log rather than swallow: treating a database error as "not an admin" is
  // exactly what made the failure above invisible.
  if (adminError) {
    console.error(`[Auth] Could not read admin_profiles for ${user.id}:`, adminError.message);
  }

  const isAdmin = !!adminRow;

  return {
    user,
    role: isAdmin ? "admin" : "member",
    isAdmin,
    userId: user.id,
    // Absent until 20260830000002 has run; absence means "holds no office",
    // which is the correct answer either way.
    officerRole:
      (adminRow as { officer_role?: OfficerRole | null } | null)?.officer_role ?? null,
  };
}
