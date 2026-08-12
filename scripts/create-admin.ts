/**
 * Bootstrap an admin account.
 *
 * Admins live in the `admin_profiles` table; a row there grants admin access.
 * The /admins API requires an existing admin, so the FIRST admin must be
 * created here with the service role.
 *
 * Run: bun run scripts/create-admin.ts <email> <password> "<full name>" [phone]
 */

import { supabase } from "@/lib/supabase";

async function createAdmin() {
  const [email, password, fullName, phone] = process.argv.slice(2);

  if (!email || !password || !fullName) {
    console.error(
      'Usage: bun run scripts/create-admin.ts <email> <password> "<full name>" [phone]',
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  console.log(`Creating admin ${email}...`);

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, phone },
    // account_type must be in app_metadata — GoTrue only accepts it from the
    // admin API, so a public signup can't mint an admin. See migration
    // 20260811000001.
    app_metadata: { account_type: "admin" },
  });

  if (error) {
    console.error("Failed to create auth user:", error.message);
    process.exit(1);
  }

  const userId = data.user!.id;

  // The handle_new_user trigger inserts admin_profiles for account_type=admin;
  // upsert as a safety net in case the trigger is not present.
  const { error: upsertError } = await supabase.from("admin_profiles").upsert(
    { id: userId, full_name: fullName, email, phone: phone ?? null },
    { onConflict: "id" },
  );
  if (upsertError) {
    console.error("Auth user created but admin_profiles insert failed:", upsertError.message);
    process.exit(1);
  }

  console.log(`✓ Admin created: ${email} (${userId})`);
}

createAdmin();
