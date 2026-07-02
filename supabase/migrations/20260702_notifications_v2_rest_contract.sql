-- Migration: Notifications v2 REST contract
-- Created: 2026-07-02
-- Description: Aligns the notification tables with the v2 REST contract:
--   * type enum becomes (loan, contribution, dividend, security, meeting)
--   * notifications gain an `action` jsonb column ({ label, url })
--   * multi-device push token registry (notification_devices)
--   * preferences reshaped to push_enabled + per-category toggles
--   * unread-count helper for push badge numbers
-- Idempotent: safe whether or not 20260701_notification_type_alignment ran.

-- ============================================================================
-- 1. NOTIFICATIONS: action column + type re-map + new CHECK
-- ============================================================================

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS action JSONB DEFAULT NULL;

COMMENT ON COLUMN public.notifications.action IS
'Optional CTA: { "label": text, "url": in-app expo-router path }';

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

UPDATE public.notifications SET type = 'contribution' WHERE type = 'payment';
UPDATE public.notifications SET type = 'meeting'      WHERE type = 'announcement';
UPDATE public.notifications SET type = 'security'     WHERE type IN ('message', 'general');

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('loan', 'contribution', 'dividend', 'security', 'meeting'));

-- ============================================================================
-- 2. NOTIFICATION LOGS: same type re-map ('system' stays for internal logs)
-- ============================================================================

ALTER TABLE public.notification_logs
  DROP CONSTRAINT IF EXISTS notification_logs_type_check;

UPDATE public.notification_logs SET type = 'contribution' WHERE type = 'payment';
UPDATE public.notification_logs SET type = 'meeting'      WHERE type = 'announcement';
UPDATE public.notification_logs SET type = 'security'     WHERE type IN ('message', 'general');

ALTER TABLE public.notification_logs
  ADD CONSTRAINT notification_logs_type_check
  CHECK (type IN ('loan', 'contribution', 'dividend', 'security', 'meeting', 'system'));

-- ============================================================================
-- 3. DEVICE REGISTRY (multi-device push tokens, upsert on token)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.notification_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL DEFAULT 'unknown'
      CHECK (platform IN ('ios', 'android', 'unknown')),
    device_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.notification_devices IS
'Expo push tokens per device; a token belongs to the member last registering it';

CREATE INDEX IF NOT EXISTS idx_notification_devices_member
  ON public.notification_devices(member_id);

ALTER TABLE public.notification_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_devices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own devices" ON public.notification_devices;
CREATE POLICY "Users manage own devices"
  ON public.notification_devices FOR ALL
  USING (auth.uid() = member_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_devices TO authenticated;
GRANT ALL ON public.notification_devices TO service_role;

-- Backfill from the legacy single-token column on profiles
INSERT INTO public.notification_devices (member_id, token)
SELECT id, expo_push_token
FROM public.profiles
WHERE expo_push_token IS NOT NULL
ON CONFLICT (token) DO NOTHING;

-- ============================================================================
-- 4. PREFERENCES: push_enabled master switch + per-category toggles
--    (security has no column — it is server-enforced always-on)
-- ============================================================================

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS loan_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS contribution_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS dividend_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS meeting_enabled BOOLEAN NOT NULL DEFAULT true;

-- Carry over the old toggles, then the legacy master switch from profiles
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notification_preferences'
      AND column_name = 'payments_enabled'
  ) THEN
    UPDATE public.notification_preferences SET
      loan_enabled         = COALESCE(loans_enabled, true),
      contribution_enabled = COALESCE(payments_enabled, true),
      meeting_enabled      = COALESCE(announcements_enabled, true);
  END IF;
END $$;

UPDATE public.notification_preferences np
SET push_enabled = COALESCE(p.push_notifications_enabled, true)
FROM public.profiles p
WHERE p.id = np.member_id;

ALTER TABLE public.notification_preferences
  DROP COLUMN IF EXISTS payments_enabled,
  DROP COLUMN IF EXISTS loans_enabled,
  DROP COLUMN IF EXISTS announcements_enabled,
  DROP COLUMN IF EXISTS messages_enabled;

-- Recreate the auto-provision trigger function for the new columns
CREATE OR REPLACE FUNCTION public.handle_new_notification_preferences()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.notification_preferences (member_id)
  VALUES (NEW.id)
  ON CONFLICT (member_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 5. UNREAD COUNT HELPER (push badge numbers, one round trip for batches)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.unread_notification_counts(user_ids UUID[])
RETURNS TABLE(member_id UUID, unread BIGINT) AS $$
  SELECT n.member_id, COUNT(*)
  FROM public.notifications n
  WHERE n.member_id = ANY(user_ids) AND n.read = false
  GROUP BY n.member_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.unread_notification_counts(UUID[]) TO service_role;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
