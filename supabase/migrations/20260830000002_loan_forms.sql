-- ============================================================================
-- Loan application, guarantors and the Loan Bond — paper-form parity
--
-- Context: the cooperative's loan process runs on three documents that the
-- schema models about a fifth of. This migration adds the rest:
--
--   Part A (LOAN A)      applicant details, amount in words, an 11-row
--                        repayment schedule, borrower signature
--   Part B (LOAN BOND)   three guarantors, each with bank details and a signature
--   Part C (LOAN BOND)   amount approved, date, Secretary AND President signatures
--   The Bond (LOAN B)    the deed itself, plus a cancellation clause both
--                        officers sign once the loan is fully repaid
--
-- The cooperative's repayment rule, taken from the bond ("repay the principal
-- within ELEVEN months in equal installments") and Part A's eleven month/amount
-- rows: a 12-month term is ONE month of grace after disbursement followed by
-- ELEVEN equal payments. See src/services/loanSchedule.ts.
--
-- REQUIRED COMPANION CHANGES (same commit — §1 below is why):
--   src/services/loanSchedule.ts    — grace + installment maths
--   src/routes/v1/loans.ts          — apply/sign routes
--   src/middleware/requireOfficer.ts
-- ============================================================================


-- ============================================================================
-- 1. Close the open path to disbursing arbitrary money
--
-- 20240601_initial_schema.sql grants members an INSERT on loans:
--
--   CREATE POLICY "Users can create loan applications"
--     ON public.loans FOR INSERT
--     WITH CHECK (auth.uid() = member_id);
--
-- RLS is enabled and FORCEd, but that policy constrains only member_id. Since
-- EXPO_PUBLIC_SUPABASE_ANON_KEY ships inside the Expo bundle, PostgREST is a
-- second entrance that does not pass through the Elysia gateway, so a member
-- could
--   POST /rest/v1/loans { "member_id": "<self>", "status": "approved",
--                         "amount_approved": 9999999 }
-- and then call POST /v1/loans/:id/disburse, which checks only
-- `status = 'approved' AND amount_approved > 0` — money out, no approval.
--
-- 20260811000001 (phase 1) listed "loan transition guards" as out of scope.
-- They stop being optional here: dual officer sign-off is theatre while a
-- member can mint an approved loan directly.
--
-- RLS is row-level and cannot say "you may write these columns but not those",
-- so as in phase 1 §2 this has to be a trigger. SECURITY INVOKER (the default)
-- is deliberate — the guard reads `current_user` to identify the caller.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.protect_loan_columns()
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

  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- An application is a request, never a decision. Everything below is
    -- established by officers at sign-off, so it is stripped rather than
    -- rejected: a member submitting a well-formed application through the
    -- gateway should not be punished for a field they did not control.
    NEW.status            := 'pending';
    NEW.amount_approved   := NULL;
    NEW.interest_rate     := NULL;
    -- tenure_months is left alone: the term is what the member is asking for,
    -- and the schema already bounds it. Officers may revise it at sign-off.
    NEW.monthly_repayment := NULL;
    NEW.balance           := NULL;
    NEW.due_date          := NULL;
    NEW.disbursed_at      := NULL;
    NEW.approved_at       := NULL;
    NEW.bond_url          := NULL;
    NEW.bond_cancelled_at := NULL;
    NEW.paystack_transfer_ref := NULL;
    NEW.recipient_code    := NULL;
    RETURN NEW;
  END IF;

  -- There is no member UPDATE policy on loans today, so this is belt and
  -- braces — but it means adding one later cannot silently reopen the hole.
  RAISE EXCEPTION 'loans are updated by the cooperative, not by the borrower'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS protect_loan_columns ON public.loans;
CREATE TRIGGER protect_loan_columns
  BEFORE INSERT OR UPDATE ON public.loans
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_loan_columns();

COMMENT ON TRIGGER protect_loan_columns ON public.loans IS
  'Forces end-user INSERTs to a pending application with no decided terms, and '
  'blocks end-user UPDATEs entirely. Raises 42501, which PostgREST maps to '
  'HTTP 403. See SYSTEM_ARCHITECTURE.md §5.';


-- ============================================================================
-- 2. Part A and bond fields on loans
--
-- The applicant_* columns are SNAPSHOTS, deliberately duplicating profiles.
-- The bond is a legal record of what was signed; a member editing their bank
-- details next year must not retroactively alter a deed.
-- ============================================================================

ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS amount_in_words        TEXT,
  ADD COLUMN IF NOT EXISTS applicant_address      TEXT,
  ADD COLUMN IF NOT EXISTS applicant_bank_name    TEXT,
  ADD COLUMN IF NOT EXISTS applicant_bank_account TEXT,
  ADD COLUMN IF NOT EXISTS applicant_phone        TEXT,
  ADD COLUMN IF NOT EXISTS borrower_signature_url TEXT,
  ADD COLUMN IF NOT EXISTS bond_signature_url     TEXT,
  ADD COLUMN IF NOT EXISTS bond_signed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grace_months           INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS first_installment_on   DATE,
  ADD COLUMN IF NOT EXISTS approved_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bond_url               TEXT,
  ADD COLUMN IF NOT EXISTS bond_cancelled_at      TIMESTAMPTZ;

COMMENT ON COLUMN public.loans.grace_months IS
  'Months after disbursement before the first installment falls due. The '
  'cooperative lends on 1 month grace + (tenure - 1) equal installments.';
COMMENT ON COLUMN public.loans.applicant_address IS
  'Snapshot taken at application time. Deliberately not a join to profiles — '
  'the bond must keep saying what the borrower signed.';
COMMENT ON COLUMN public.loans.borrower_signature_url IS
  'Object path in the private member-documents bucket, not a public URL.';
COMMENT ON COLUMN public.loans.bond_url IS
  'Object path of the generated Loan Bond PDF in member-documents.';


-- ============================================================================
-- 3. Part B — guarantors
--
-- Free text rather than a reference to profiles: the paper form asks for a
-- name, bank and phone, not a member number, and a guarantor need not be a
-- member of the cooperative. (An earlier single `guarantor_id` column was
-- dropped in 20250417 — this is not a revival of it.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.loan_guarantors (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_id       UUID NOT NULL REFERENCES public.loans(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
    full_name     TEXT NOT NULL,
    bank_name     TEXT NOT NULL,
    bank_account  TEXT NOT NULL,
    phone         TEXT NOT NULL,
    signature_url TEXT,
    signed_at     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT loan_guarantors_unique_position UNIQUE (loan_id, position)
);

COMMENT ON TABLE public.loan_guarantors IS
  'Part B of the loan application. Exactly three per loan, enforced by the API.';

CREATE INDEX IF NOT EXISTS idx_loan_guarantors_loan ON public.loan_guarantors(loan_id);


-- ============================================================================
-- 4. Part A item 8 — the repayment schedule
--
-- Stored rather than derived. The borrower signs a specific set of dates and
-- amounts, and the bond has to keep reproducing exactly those even if the
-- formula, the rate or the rounding rule changes later.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.loan_installments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_id        UUID NOT NULL REFERENCES public.loans(id) ON DELETE CASCADE,
    installment_no INTEGER NOT NULL CHECK (installment_no > 0),
    due_on         DATE NOT NULL,
    amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    paid_amount    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
    status         TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'paid', 'late')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT loan_installments_unique_no UNIQUE (loan_id, installment_no)
);

COMMENT ON TABLE public.loan_installments IS
  'The dated month/amount rows of Part A item 8, generated at approval.';

CREATE INDEX IF NOT EXISTS idx_loan_installments_loan ON public.loan_installments(loan_id);
CREATE INDEX IF NOT EXISTS idx_loan_installments_due  ON public.loan_installments(due_on)
  WHERE status <> 'paid';

DROP TRIGGER IF EXISTS handle_loan_installments_updated_at ON public.loan_installments;
CREATE TRIGGER handle_loan_installments_updated_at
  BEFORE UPDATE ON public.loan_installments
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();


-- ============================================================================
-- 5. Officer roles
--
-- Part C and the bond's OFFICE USE ONLY are signed by the Secretary and the
-- President specifically, not by "an admin". admin_profiles previously carried
-- only is_super_admin, which says nothing about which office a person holds.
--
-- The partial unique index enforces at most one sitting holder of each office;
-- reassigning means clearing the incumbent first, which is the correct amount
-- of friction for a change of officers.
-- ============================================================================

ALTER TABLE public.admin_profiles
  ADD COLUMN IF NOT EXISTS officer_role TEXT
    CHECK (officer_role IN ('secretary', 'president'));

COMMENT ON COLUMN public.admin_profiles.officer_role IS
  'Cooperative office held, if any. Both offices must sign a loan for it to be approved.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_profiles_one_per_office
  ON public.admin_profiles (officer_role)
  WHERE officer_role IS NOT NULL;


-- ============================================================================
-- 6. Part C — officer signatures
--
-- One row per (loan, office, action). The unique constraint is what makes a
-- double-tap idempotent and stops one officer approving a loan twice to satisfy
-- the two-signature rule on their own.
--
-- The proposed terms live here, not just on the loan, so the record shows what
-- the first officer put forward and the second countersigned.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.loan_approvals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_id         UUID NOT NULL REFERENCES public.loans(id) ON DELETE CASCADE,
    officer_id      UUID NOT NULL REFERENCES public.admin_profiles(id) ON DELETE RESTRICT,
    officer_role    TEXT NOT NULL CHECK (officer_role IN ('secretary', 'president')),
    action          TEXT NOT NULL CHECK (action IN ('approve', 'cancel_bond')),
    amount_approved NUMERIC(12,2),
    interest_rate   NUMERIC(5,2),
    tenure_months   INTEGER,
    signature_url   TEXT,
    signed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT loan_approvals_one_per_office UNIQUE (loan_id, officer_role, action)
);

COMMENT ON TABLE public.loan_approvals IS
  'Part C and the bond OFFICE USE ONLY blocks. A loan reaches `approved` only '
  'once both offices have an `approve` row; the bond is cancelled only once '
  'both have a `cancel_bond` row.';

CREATE INDEX IF NOT EXISTS idx_loan_approvals_loan ON public.loan_approvals(loan_id);

-- ON DELETE RESTRICT on officer_id is deliberate: a signature is evidence that
-- a named officer approved a sum of money. Removing an admin must not quietly
-- erase who signed. Retiring an officer means clearing officer_role, not
-- deleting the account.


-- ============================================================================
-- 7. RLS on the new tables
--
-- Admin-only, with no anon or authenticated policy — the same posture as
-- registration_windows. Members read their own guarantors and schedule through
-- the gateway (GET /v1/loans/:id), which already scopes by member_id; giving
-- PostgREST a second door would mean re-deriving that scoping in SQL.
-- ============================================================================

ALTER TABLE public.loan_guarantors    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_guarantors    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.loan_installments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_installments  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.loan_approvals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_approvals     FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage loan guarantors" ON public.loan_guarantors;
CREATE POLICY "Admins can manage loan guarantors"
  ON public.loan_guarantors FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins can manage loan installments" ON public.loan_installments;
CREATE POLICY "Admins can manage loan installments"
  ON public.loan_installments FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins can manage loan approvals" ON public.loan_approvals;
CREATE POLICY "Admins can manage loan approvals"
  ON public.loan_approvals FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));


-- ============================================================================
-- 8. Storage
--
-- No new bucket. Loan signatures and bonds go into the existing private
-- member-documents bucket (created in 20260830000001) under loans/<loan_id>/,
-- read through short-lived signed URLs like every other document there.
-- ============================================================================
