-- Server-side Paystack payment verification
--
-- 1. Remap the client-invented 'verified' status to the canonical 'success'
--    (everything — reports, loan eligibility, dividends, notifications —
--    checks for 'success').
-- 2. Enforce the payment_status vocabulary going forward.
-- 3. Unique transaction_ref: one contribution per Paystack reference, backing
--    the idempotency of POST /contributions/verify and the charge.success
--    webhook.

-- 1. Remap legacy values
UPDATE public.contributions
SET payment_status = 'success'
WHERE payment_status = 'verified';

UPDATE public.contributions
SET payment_status = 'failed'
WHERE payment_status = 'rejected';

-- 2. Constrain payment_status
ALTER TABLE public.contributions
  DROP CONSTRAINT IF EXISTS contributions_payment_status_check;
ALTER TABLE public.contributions
  ADD CONSTRAINT contributions_payment_status_check
  CHECK (payment_status IN ('pending', 'success', 'failed', 'abandoned'));

-- 3. One contribution per Paystack reference (NULLs = manual entries, allowed)
CREATE UNIQUE INDEX IF NOT EXISTS uq_contributions_transaction_ref
  ON public.contributions (transaction_ref)
  WHERE transaction_ref IS NOT NULL;
