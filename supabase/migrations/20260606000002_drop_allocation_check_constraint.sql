-- Migration: Drop allocation CHECK constraint
-- Created: 2026-06-06
-- Description: Drops the CHECK constraint on contributions allocation columns
-- because amount is stored in kobo (×100) while allocation values are in Naira.

ALTER TABLE public.contributions DROP CONSTRAINT IF EXISTS contributions_allocation_check;
