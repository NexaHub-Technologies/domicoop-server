-- Migration: Add contribution allocation columns
-- Created: 2026-06-06
-- Description: Adds Shares, Social, Savings, Deposit allocation columns to contributions table
-- based on the cooperative's fixed-fee and capped allocation policy.

-- Add allocation columns (nullable for backfill compatibility)
ALTER TABLE public.contributions
  ADD COLUMN IF NOT EXISTS shares DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS social DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS savings DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS deposit DECIMAL(10,2);

COMMENT ON COLUMN public.contributions.shares IS 'Fixed monthly amount allocated to Shares pool (₦4,000)';
COMMENT ON COLUMN public.contributions.social IS 'Fixed monthly amount allocated to Social welfare pool (₦1,000)';
COMMENT ON COLUMN public.contributions.savings IS 'Flexible savings component, capped at ₦46,000/mo';
COMMENT ON COLUMN public.contributions.deposit IS 'Overflow deposit beyond ₦51,000 ceiling';
