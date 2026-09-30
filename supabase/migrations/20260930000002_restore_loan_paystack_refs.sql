-- Migration: Restore Paystack transfer references on loans
--
-- Disbursement is automated via Paystack again
-- (POST /v1/loans/:id/disburse), so loans stores the transfer reference and
-- recipient code the webhook handlers reconcile against. Reverses
-- 20260930000001.

ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS paystack_transfer_ref TEXT,
  ADD COLUMN IF NOT EXISTS recipient_code TEXT;

-- protect_loan_columns() must know about the restored columns again: member
-- INSERTs strip them (an application is never a decision), exactly as before.
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
