-- Migration: Normalize contributions.amount to Naira
-- Created: 2026-07-05
-- Description:
--   Historically, contributions.amount for SUCCESSFUL rows was stored in kobo
--   (Paystack's smallest currency unit, i.e. amount * 100), while the allocation
--   columns (shares/social/savings/deposit) were stored in Naira. This made
--   contributions.amount inconsistent with its own allocation breakdown and with
--   every balance/total the API derives from it (GET /contributions total_balance,
--   dashboard totals, reports, dividend contribution amounts).
--
--   Going forward the application stores contributions.amount in Naira. This
--   migration backfills existing successful rows from kobo -> Naira.
--
--   NOTE: transactions.amount is intentionally left in kobo (it mirrors Paystack's
--   raw transaction ledger) and is out of scope for this migration.
--
--   Pending/failed rows created via POST /contributions already stored Naira, so
--   only payment_status = 'success' rows are touched.

BEGIN;

-- Preferred, unit-agnostic backfill: for successful rows that carry an allocation
-- breakdown, amount MUST equal shares + social + savings + deposit (all Naira).
-- This is exact and safe regardless of whether amount was previously kobo, and is
-- a no-op for any row already correct.
UPDATE public.contributions
SET amount = COALESCE(shares, 0) + COALESCE(social, 0)
           + COALESCE(savings, 0) + COALESCE(deposit, 0)
WHERE payment_status = 'success'
  AND shares IS NOT NULL
  AND amount <> COALESCE(shares, 0) + COALESCE(social, 0)
              + COALESCE(savings, 0) + COALESCE(deposit, 0);

-- Fallback for legacy successful rows created before allocation columns existed
-- (2026-06-06). The Paystack collection path has always written kobo for these,
-- so convert kobo -> Naira. If your dataset contains legacy success rows that were
-- stored in Naira, review them manually before running this statement.
UPDATE public.contributions
SET amount = amount / 100
WHERE payment_status = 'success'
  AND shares IS NULL;

COMMENT ON COLUMN public.contributions.amount IS
  'Contribution amount in Naira (NGN). For successful, allocated rows this equals shares + social + savings + deposit.';

COMMIT;
