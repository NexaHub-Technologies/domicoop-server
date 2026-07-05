-- Migration: Drop FK constraint on announcements.author_id
-- Created: 2026-07-05
-- Description:
--   announcements.author_id references profiles(id), but admins (who create
--   and broadcast announcements) have rows in admin_profiles, not profiles.
--   This causes a foreign key violation when an admin inserts an announcement.
--
--   The column remains UUID and nullable. Author attribution is preserved (the
--   admin's auth UUID is still stored), but PostgreSQL no longer enforces that
--   it must exist in profiles.

BEGIN;

ALTER TABLE public.announcements
  DROP CONSTRAINT IF EXISTS announcements_author_id_fkey;

COMMIT;
