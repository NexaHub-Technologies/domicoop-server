-- ============================================================================
-- Membership registration portal — time-boxed intake windows
--
-- Context: the cooperative does not register members continuously. It opens an
-- intake for a period, collects the paper MEMBERSHIP REGISTRATION FORM (MEM),
-- takes a non-refundable ₦20,000 registration fee plus a ₦1,000 social fee,
-- and closes. The app has until now offered an always-open sign-up collecting
-- ten fields and charging nothing.
--
-- This migration adds the window as data, widens profiles to the paper form's
-- fields, and — importantly — extends the phase 1 column guard so the new
-- money-bearing columns are not self-writable. See
-- 20260811000001_phase1_harden_authorization.sql for why that guard exists and
-- why WITH CHECK alone is not sufficient.
--
-- REQUIRED COMPANION CHANGES (same commit):
--   src/services/registrationWindow.ts   — openness is computed here
--   src/services/memberRegistration.ts   — the only writer of the guarded cols
--   src/routes/v1/registration.ts        — public + admin surface
--   src/routes/v1/auth.ts                — legacy /auth/register gets gated
-- ============================================================================


-- ============================================================================
-- 1. registration_windows
--
-- Windows are kept as history rather than overwritten: each intake has its own
-- fees, and an approved member's registration_window_id has to keep pointing
-- at the terms they actually signed up under.
--
-- Openness is NOT a stored boolean. It is derived from state + the clock +
-- capacity, because two of those three change without anybody writing a row.
-- `state` is only the manual override: draft (not yet announced), open
-- (admin has released it), closed (admin has ended it, or it is archived).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.registration_windows (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                     TEXT NOT NULL,
    opens_at                 TIMESTAMPTZ NOT NULL,
    closes_at                TIMESTAMPTZ NOT NULL,
    state                    TEXT NOT NULL DEFAULT 'draft'
                               CHECK (state IN ('draft', 'open', 'closed')),
    capacity                 INTEGER CHECK (capacity IS NULL OR capacity > 0),
    applications_count       INTEGER NOT NULL DEFAULT 0,

    -- All amounts are whole Naira, per docs/currency-contract.md. Defaults are
    -- the figures printed on the MEM form.
    registration_fee         NUMERIC(12,2) NOT NULL DEFAULT 20000 CHECK (registration_fee >= 0),
    social_fee               NUMERIC(12,2) NOT NULL DEFAULT 1000  CHECK (social_fee >= 0),
    min_monthly_subscription NUMERIC(12,2) NOT NULL DEFAULT 5000  CHECK (min_monthly_subscription > 0),
    max_monthly_subscription NUMERIC(12,2) NOT NULL DEFAULT 50000,

    created_by               UUID REFERENCES public.admin_profiles(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT registration_windows_period_valid CHECK (closes_at > opens_at),
    CONSTRAINT registration_windows_subscription_range
      CHECK (max_monthly_subscription >= min_monthly_subscription)
);

COMMENT ON TABLE public.registration_windows IS
  'Time-boxed membership intakes. Openness is derived (state + clock + capacity), never stored.';
COMMENT ON COLUMN public.registration_windows.state IS
  'Manual override only: draft | open | closed. An open window is still shut outside [opens_at, closes_at] or at capacity.';
COMMENT ON COLUMN public.registration_windows.applications_count IS
  'Maintained by the count_registration_application trigger on profiles.';

-- At most one window may be live at a time. Two overlapping intakes would make
-- "which fees apply to this applicant" ambiguous at the moment of payment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_windows_single_live
  ON public.registration_windows ((true))
  WHERE state <> 'closed';

CREATE INDEX IF NOT EXISTS idx_registration_windows_closes_at
  ON public.registration_windows(closes_at DESC);

DROP TRIGGER IF EXISTS handle_registration_windows_updated_at ON public.registration_windows;
CREATE TRIGGER handle_registration_windows_updated_at
  BEFORE UPDATE ON public.registration_windows
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- RLS with no anon/authenticated policy, deliberately.
--
-- EXPO_PUBLIC_SUPABASE_ANON_KEY ships inside the Expo bundle, so PostgREST is
-- a second, unauthenticated entrance to every table. The public window lookup
-- is served by the Elysia gateway with the service-role key
-- (GET /v1/registration/window), which also lets it withhold `capacity` and
-- internal ids from applicants. Nothing here should be readable with the
-- shipped key, so nothing is granted.
ALTER TABLE public.registration_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registration_windows FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage registration windows" ON public.registration_windows;
CREATE POLICY "Admins can manage registration windows"
  ON public.registration_windows FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));


-- ============================================================================
-- 2. The MEM form's fields on profiles
--
-- All nullable: every existing member predates the paper-parity form and has
-- none of these. Approval does not depend on them, so backfilling is a
-- separate, manual exercise.
--
-- monthly_subscription is the amount the member committed to on the form. It
-- is a declaration, not an enforced debit — contributions remain validated
-- against docs/currency-contract.md, not against this column.
-- ============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS sex                    TEXT,
  ADD COLUMN IF NOT EXISTS date_of_birth          DATE,
  ADD COLUMN IF NOT EXISTS whatsapp_number        TEXT,
  ADD COLUMN IF NOT EXISTS marital_status         TEXT,
  ADD COLUMN IF NOT EXISTS id_card_number         TEXT,
  ADD COLUMN IF NOT EXISTS place_of_work          TEXT,
  ADD COLUMN IF NOT EXISTS type_of_business       TEXT,
  ADD COLUMN IF NOT EXISTS referred_by            TEXT,
  ADD COLUMN IF NOT EXISTS signature_url          TEXT,
  ADD COLUMN IF NOT EXISTS monthly_subscription   NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS registration_window_id UUID REFERENCES public.registration_windows(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS registration_fee_paid  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS registration_paid_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registration_ref       TEXT;

COMMENT ON COLUMN public.profiles.signature_url IS
  'Object path in the private member-documents bucket, not a public URL. Read via signed URL.';
COMMENT ON COLUMN public.profiles.registration_ref IS
  'Paystack reference for the registration + social fee charge. Mirrors transactions.paystack_ref.';
COMMENT ON COLUMN public.profiles.monthly_subscription IS
  'Subscription the member declared on the MEM form. Informational; contributions are validated separately.';

CREATE INDEX IF NOT EXISTS idx_profiles_registration_window
  ON public.profiles(registration_window_id)
  WHERE registration_window_id IS NOT NULL;


-- ============================================================================
-- 3. Extend the phase 1 column guard
--
-- registration_fee_paid is the record that ₦21,000 arrived. Without adding it
-- here, a member holding an ordinary JWT could
--   PATCH /rest/v1/profiles?id=eq.<self>  { "registration_fee_paid": true }
-- and mark themselves paid — the exact shape of the status self-approval hole
-- that 20260811000001 §2 closed. RLS cannot express "these columns but not
-- those", so it has to be the trigger.
--
-- This is a rewrite of the phase 1 function, not a second trigger: two BEFORE
-- UPDATE guards on one table would both have to be kept in sync, and the
-- ordering between them would be alphabetical rather than intentional.
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

  -- Registration facts are established by verified payment, in
  -- src/services/memberRegistration.ts, using the service-role key.
  IF NEW.registration_fee_paid IS DISTINCT FROM OLD.registration_fee_paid
     OR NEW.registration_paid_at IS DISTINCT FROM OLD.registration_paid_at
     OR NEW.registration_ref IS DISTINCT FROM OLD.registration_ref THEN
    RAISE EXCEPTION 'registration payment status is set by payment verification, not by the member'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.registration_window_id IS DISTINCT FROM OLD.registration_window_id THEN
    RAISE EXCEPTION 'registration_window_id is assigned at application time and is immutable'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON TRIGGER protect_profile_columns ON public.profiles IS
  'Blocks end-user writes to status/role/member_no/email and the registration_* '
  'columns. Raises 42501, which PostgREST maps to HTTP 403. '
  'See SYSTEM_ARCHITECTURE.md §5.';


-- ============================================================================
-- 4. handle_new_user() carries the MEM fields through
--
-- Registration passes the whole form to auth.signUp({ options: { data } }), so
-- the trigger is what lands it in profiles. The admin branch is untouched: it
-- reads raw_app_meta_data, which a public signup cannot set, and that is the
-- entire point of 20260811000001 §1 — do not "simplify" it back.
--
-- The registration_* columns are deliberately NOT set here. raw_user_meta_data
-- is client-supplied, and letting it seed registration_fee_paid would reopen
-- the hole §3 just closed. The gateway sets them afterwards, service-role,
-- only once Paystack has confirmed the charge.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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
    sex, date_of_birth, whatsapp_number, marital_status, id_card_number,
    place_of_work, type_of_business, referred_by, monthly_subscription,
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
    NEW.raw_user_meta_data->>'sex',
    -- A malformed date from a client must not take down signup; NULLIF+cast
    -- would still raise, so parse defensively.
    CASE
      WHEN NEW.raw_user_meta_data->>'date_of_birth' ~ '^\d{4}-\d{2}-\d{2}$'
        THEN (NEW.raw_user_meta_data->>'date_of_birth')::DATE
      ELSE NULL
    END,
    NEW.raw_user_meta_data->>'whatsapp_number',
    NEW.raw_user_meta_data->>'marital_status',
    NEW.raw_user_meta_data->>'id_card_number',
    NEW.raw_user_meta_data->>'place_of_work',
    NEW.raw_user_meta_data->>'type_of_business',
    NEW.raw_user_meta_data->>'referred_by',
    CASE
      WHEN NEW.raw_user_meta_data->>'monthly_subscription' ~ '^\d+(\.\d+)?$'
        THEN (NEW.raw_user_meta_data->>'monthly_subscription')::NUMERIC
      ELSE NULL
    END,
    'pending',
    'member'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'Creates an admin_profiles or profiles row for a new auth user, carrying the MEM registration fields from user metadata. Never sets registration_* columns.';


-- ============================================================================
-- 5. applications_count
--
-- Counted on the profiles row rather than incremented by the gateway, so the
-- capacity check cannot drift from reality if a registration half-fails.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.count_registration_application()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The window is stamped by the gateway in a follow-up UPDATE (the trigger in
  -- §4 cannot set it), so both paths have to be observed.
  IF TG_OP = 'INSERT' THEN
    IF NEW.registration_window_id IS NOT NULL THEN
      UPDATE public.registration_windows
        SET applications_count = applications_count + 1
        WHERE id = NEW.registration_window_id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.registration_window_id IS DISTINCT FROM OLD.registration_window_id THEN
    IF OLD.registration_window_id IS NOT NULL THEN
      UPDATE public.registration_windows
        SET applications_count = GREATEST(applications_count - 1, 0)
        WHERE id = OLD.registration_window_id;
    END IF;
    IF NEW.registration_window_id IS NOT NULL THEN
      UPDATE public.registration_windows
        SET applications_count = applications_count + 1
        WHERE id = NEW.registration_window_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS count_registration_application ON public.profiles;
CREATE TRIGGER count_registration_application
  AFTER INSERT OR UPDATE OF registration_window_id ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.count_registration_application();

-- A deleted applicant frees their slot.
CREATE OR REPLACE FUNCTION public.uncount_registration_application()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.registration_window_id IS NOT NULL THEN
    UPDATE public.registration_windows
      SET applications_count = GREATEST(applications_count - 1, 0)
      WHERE id = OLD.registration_window_id;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS uncount_registration_application ON public.profiles;
CREATE TRIGGER uncount_registration_application
  AFTER DELETE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.uncount_registration_application();


-- ============================================================================
-- 6. transactions.type gains 'registration'
--
-- The registration fee is real money through Paystack and belongs in the same
-- ledger as everything else — not least because transactions.paystack_ref is
-- UNIQUE, which is what makes replaying a paid reference impossible.
-- ============================================================================

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('contribution', 'loan_repayment', 'levy', 'dividend', 'registration'));


-- ============================================================================
-- 7. member-documents bucket
--
-- Private. Signatures are handwriting tied to a name, address and ID number;
-- a public bucket would make every one of them enumerable. The gateway writes
-- with the service-role key and hands out short-lived signed URLs, so no
-- storage.objects policy is granted to anon or authenticated.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'member-documents',
  'member-documents',
  false,
  5242880,                                   -- 5 MB
  ARRAY['image/png', 'image/jpeg', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;
