-- Migration: Add Paystack transfer references to loans
-- Created: 2026-04-27
-- Description: Add columns for tracking Paystack transfer references and recipient codes for loan disbursement

ALTER TABLE loans 
ADD COLUMN IF NOT EXISTS paystack_transfer_ref TEXT,
ADD COLUMN IF NOT EXISTS recipient_code TEXT;

-- Add disbursement_failed to the status check constraint
-- First, drop the existing check constraint
ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_status_check;

-- Recreate with the new status
ALTER TABLE loans ADD CONSTRAINT loans_status_check 
CHECK (status IN ('pending', 'under_review', 'approved', 'rejected', 'disbursed', 'repaying', 'closed', 'disbursement_failed'));