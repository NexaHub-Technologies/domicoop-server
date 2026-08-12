-- ============================================================================
-- Phase 1 — close the exposed authorization surface
--
-- Context: docs/SYSTEM_ARCHITECTURE.md §9 (build plan, phase 1). Fixes the
-- divergences recorded in §4 (admin is self-assignable) and §5 (RLS is live on
-- the public internet and three UPDATE policies are permissive).
--
-- Why this is urgent: EXPO_PUBLIC_SUPABASE_ANON_KEY ships inside the Expo
-- bundle, so PostgREST is a second, unauthenticated entrance to these tables
-- that does not pass through the Elysia gateway. Verified 2026-08-11:
-- `GET /rest/v1/profiles` with the anon key returns `200 []`, not
-- `permission denied` — base GRANTs exist via Supabase default privileges, so
-- every policy below is enforced exactly as written.
--
-- This migration is additive and requires no client changes. It DOES require
-- two server changes shipped in the same commit (see §1 below), without which
-- admin creation silently produces a member profile instead of an admin.
--
-- Not in scope (phase 2+): scoping policies TO authenticated, writing GRANTs
-- explicitly, admin policies on the money tables, loan transition guards.
-- ============================================================================


-- ============================================================================
-- 1. Admin creation stops trusting client-supplied metadata
--
-- Before: handle_new_user() branched on
--   NEW.raw_user_meta_data->>'account_type' = 'admin'
-- raw_user_meta_data is whatever the caller passed to
-- auth.signUp({ options: { data } }), and signup is public. Anyone could mint
-- an admin_profiles row, which is the sole definition of "admin" for BOTH
-- public.is_admin() in every admin RLS policy AND resolveUserFromToken() in
-- the gateway — so it granted loan approval, disbursement, and dividend
-- distribution.
--
-- After: the branch reads raw_app_meta_data, which GoTrue does not accept from
-- a public signup. It can only be set through the admin API with the service
-- role key.
--
-- REQUIRED COMPANION CHANGES (same commit):
--   src/routes/v1/admins.ts   — pass app_metadata: { account_type: 'admin' }
--   scripts/create-admin.ts   — same
-- Both already upsert admin_profiles defensively afterwards, so admin creation
-- keeps working; without the change they would fall through to the member
-- branch and get a profiles row.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- app_metadata is server-controlled; user_metadata is not. This is the whole
  -- point of the change — do not "simplify" this back to raw_user_meta_data.
  IF NEW.raw_app_meta_data->>'account_type' = 'admin' THEN
    INSERT INTO public.admin_profiles (id, full_name, email, phone, avatar_url)
    VALUES (
      NEW.id,
      COALESCE(
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name',
        'Admin'
      ),
      NEW.email,
      NEW.raw_user_meta_data->>'phone',
      NEW.raw_user_meta_data->>'avatar_url'
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
  END IF;

  INSERT INTO public.profiles (
    id, full_name, email, phone, address,
    bank_name, bank_account, bank_code, avatar_url, next_of_kin,
    status, role
  )
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      'New Member'
    ),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    COALESCE(NEW.raw_user_meta_data->>'address', ''),
    COALESCE(NEW.raw_user_meta_data->>'bank_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'bank_account', ''),
    COALESCE(NEW.raw_user_meta_data->>'bank_code', ''),
    NEW.raw_user_meta_data->>'avatar_url',
    NEW.raw_user_meta_data->>'next_of_kin',
    'pending',
    'member'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Any admin_profiles row created before this migration came from an untrusted
-- path and cannot be distinguished from a legitimate one. Report them so they
-- can be reconciled by hand; deleting automatically would cascade.
DO $$
DECLARE
  n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM public.admin_profiles;
  RAISE NOTICE
    'Phase 1: % admin_profiles row(s) exist. Every one predates the metadata fix — verify each is intended.',
    n;
END;
$$;


-- ============================================================================
-- 2. Column protection on profiles
--
-- WITH CHECK (added in §4) is NOT sufficient here, and this is worth stating
-- because it is the intuitive fix and it does not work: WITH CHECK re-tests
-- `auth.uid() = id`, which is still true after a member sets their own
-- status = 'active'. RLS is row-level and cannot express "you may write these
-- columns but not those." That needs a trigger.
--
-- Without this, a member holding an ordinary JWT could
--   PATCH /rest/v1/profiles?id=eq.<self>  { "status": "active" }
-- and self-approve — which also fires on_member_approved and mints a member
-- number.
--
-- SECURITY INVOKER (the default) is deliberate: the guard reads `current_user`
-- to identify the caller, and SECURITY DEFINER would rewrite it to the owner.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.protect_profile_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Only constrain callers arriving through PostgREST as an end user.
  -- service_role (the gateway), postgres (migrations, cron) and any other role
  -- pass through untouched. Fail-open for privileged paths, closed for clients.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- Admins may legitimately approve and suspend members.
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'status is set by an administrator, not by the member'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'role is not self-assignable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.member_no IS DISTINCT FROM OLD.member_no THEN
    RAISE EXCEPTION 'member_no is assigned on approval and is immutable'
      USING ERRCODE = '42501';
  END IF;

  -- email mirrors auth.users and is maintained by handle_user_email_update().
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'email is changed through the auth system, not directly'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_columns ON public.profiles;
CREATE TRIGGER protect_profile_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_columns();

COMMENT ON TRIGGER protect_profile_columns ON public.profiles IS
  'Blocks end-user writes to status/role/member_no/email. Raises 42501, which '
  'PostgREST maps to HTTP 403. See SYSTEM_ARCHITECTURE.md §5.';


-- ============================================================================
-- 3. Column protection on contributions
--
-- Same reasoning. The existing policy admits rows where
-- payment_status = 'pending' (checked BEFORE the write), so a member could
-- flip their own contribution to 'success' — and, since nothing re-derives it,
-- also rewrite amount and the four allocation buckets.
--
-- A separate function per table, rather than one shared function branching on
-- TG_TABLE_NAME: PL/pgSQL evaluates the whole record reference regardless of
-- the branch, so a shared guard errors with `record "new" has no field ...`
-- on whichever table lacks the column.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.protect_contribution_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    RAISE EXCEPTION 'payment_status is set by payment verification, not by the member'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.shares IS DISTINCT FROM OLD.shares
     OR NEW.social IS DISTINCT FROM OLD.social
     OR NEW.savings IS DISTINCT FROM OLD.savings
     OR NEW.deposit IS DISTINCT FROM OLD.deposit THEN
    RAISE EXCEPTION 'contribution amounts and allocations are derived, not writable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.transaction_ref IS DISTINCT FROM OLD.transaction_ref THEN
    RAISE EXCEPTION 'transaction_ref is immutable'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_contribution_columns ON public.contributions;
CREATE TRIGGER protect_contribution_columns
  BEFORE UPDATE ON public.contributions
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_contribution_columns();


-- ============================================================================
-- 4. WITH CHECK on the three permissive UPDATE policies
--
-- These policies had USING with no WITH CHECK, so the row was tested only in
-- its pre-update state. Adding WITH CHECK stops a member reassigning a row to
-- someone else (setting id / member_id to another user). Column-level
-- protection is §2 and §3 above — the two do different jobs and both are
-- needed.
-- ============================================================================

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own pending contributions" ON public.contributions;
CREATE POLICY "Users can update own pending contributions"
  ON public.contributions FOR UPDATE
  USING (auth.uid() = member_id AND payment_status = 'pending')
  WITH CHECK (auth.uid() = member_id AND payment_status = 'pending');

DROP POLICY IF EXISTS "Users can update own notifications" ON public.notifications;
CREATE POLICY "Users can update own notifications"
  ON public.notifications FOR UPDATE
  USING (auth.uid() = member_id)
  WITH CHECK (auth.uid() = member_id);

-- notifications gets no column-protection trigger: the only writable content
-- is the member's own inbox row, and editing one's own notification body has
-- no privilege or money consequence. Revisit if `data`/`action` ever drive
-- client behaviour.


-- ============================================================================
-- 5. Revoke the open SECURITY DEFINER RPCs
--
-- EXECUTE on a new function is granted to PUBLIC by default and nothing
-- revoked it, so both of these answered the anon key with HTTP 200 (verified
-- 2026-08-11). cleanup_old_notifications() additionally DELETEs rows — an
-- unauthenticated destructive endpoint.
--
-- public.is_admin() is deliberately NOT revoked. RLS policy expressions
-- execute with the privileges of the querying role, and `anon` evaluates
-- is_admin() while reading published announcements (the "Admins can manage
-- announcements" policy applies to every role, because no policy is scoped
-- TO authenticated yet). Revoking it would break public announcement reads
-- with `permission denied for function is_admin`. It leaks only a boolean and
-- stops being anon-reachable in phase 2, when policies get role-scoped.
-- ============================================================================

REVOKE ALL ON FUNCTION public.cleanup_old_notifications()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_notifications()
  TO service_role;

REVOKE ALL ON FUNCTION public.unread_notification_counts(UUID[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unread_notification_counts(UUID[])
  TO service_role;

-- Both are called by the server with the service-role key
-- (src/jobs/cleanupNotifications.ts, src/services/notificationService.ts),
-- so neither call site changes.


-- ============================================================================
-- 6. Pin search_path on the remaining SECURITY DEFINER functions
--
-- A SECURITY DEFINER function with a mutable search_path can be induced to
-- resolve an unqualified name against a schema the caller controls. Two of
-- these are triggers on auth.users, which makes it a real escalation surface
-- rather than a linter complaint. handle_new_user() was already pinned in §1.
-- ============================================================================

ALTER FUNCTION public.handle_user_email_update()            SET search_path = public;
ALTER FUNCTION public.log_profile_changes()                 SET search_path = public;
ALTER FUNCTION public.handle_new_notification_preferences() SET search_path = public;
ALTER FUNCTION public.cleanup_old_notifications()           SET search_path = public;
ALTER FUNCTION public.unread_notification_counts(UUID[])    SET search_path = public;


-- ============================================================================
-- Verification gate — see scripts/verify_phase1.sh for the anon-key probes.
--
-- The assertions that matter are negative, and must run as a real end-user
-- role. Testing as the table owner proves nothing: owners bypass RLS, and
-- `current_user` would not be 'authenticated', so §2 and §3 would not fire.
--
--   SET LOCAL role authenticated;
--   SET LOCAL request.jwt.claims = '{"sub":"<member-uuid>","role":"authenticated"}';
--   UPDATE public.profiles SET status = 'active' WHERE id = '<member-uuid>';
--   -- expected: ERROR 42501
--
--   UPDATE public.profiles SET full_name = 'Ada' WHERE id = '<member-uuid>';
--   -- expected: UPDATE 1
-- ============================================================================
