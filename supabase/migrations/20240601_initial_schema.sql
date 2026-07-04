-- Migration: Initial Database Schema
-- Created: 2024-06-15
-- Description: Creates all tables for DOMICOOP application

-- ============================================================================
-- 1. PROFILES TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    bank_name TEXT,
    bank_account TEXT,
    bank_code TEXT,
    next_of_kin TEXT,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
    onboarding_step INTEGER NOT NULL DEFAULT 1,
    onboarding_done BOOLEAN NOT NULL DEFAULT false,
    fcm_token TEXT,
    avatar_url TEXT,
    member_no TEXT UNIQUE,
    preferences JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.profiles IS 'Member profiles linked to auth.users';

-- ============================================================================
-- 2. LOANS TABLE (Created before transactions to avoid FK dependency issues)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.loans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    amount_requested DECIMAL(10,2) NOT NULL CHECK (amount_requested > 0),
    amount_approved DECIMAL(10,2),
    purpose TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('emergency', 'personal', 'housing', 'education', 'business')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'under_review', 'approved', 'rejected', 'disbursed', 'repaying', 'closed')),
    interest_rate DECIMAL(5,2) DEFAULT 5.0,
    tenure_months INTEGER,
    monthly_repayment DECIMAL(10,2),
    balance DECIMAL(10,2) DEFAULT 0,
    disbursed_at TIMESTAMPTZ,
    due_date TIMESTAMPTZ,
    admin_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.loans IS 'Loan applications and tracking';

-- ============================================================================
-- 3. CONTRIBUTIONS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    month TEXT NOT NULL, -- Format: YYYY-MM
    year INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
    proof_url TEXT,
    payment_ref TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.contributions IS 'Monthly contribution records from members';

-- ============================================================================
-- 4. TRANSACTIONS TABLE (References loans and contributions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    paystack_ref TEXT NOT NULL UNIQUE,
    amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    type TEXT NOT NULL CHECK (type IN ('contribution', 'loan_repayment', 'levy', 'dividend')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'reversed')),
    channel TEXT,
    description TEXT,
    contribution_id UUID REFERENCES public.contributions(id) ON DELETE SET NULL,
    loan_id UUID REFERENCES public.loans(id) ON DELETE SET NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.transactions IS 'Payment transactions via Paystack';

-- ============================================================================
-- 5. DIVIDENDS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.dividends (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    year INTEGER NOT NULL,
    paystack_transfer_ref TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'success', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.dividends IS 'Dividend distributions to members';

-- ============================================================================
-- 6. MESSAGES TABLE (Support Tickets)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.messages IS 'Support tickets from members';

-- ============================================================================
-- 7. MESSAGE REPLIES TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.message_replies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.message_replies IS 'Replies to support tickets';

-- ============================================================================
-- 8. NOTIFICATIONS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('payment', 'loan', 'announcement', 'message', 'general')),
    read BOOLEAN NOT NULL DEFAULT false,
    data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.notifications IS 'User notifications';

-- ============================================================================
-- 9. ANNOUNCEMENTS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    author_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    published BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.announcements IS 'System announcements for members';

-- ============================================================================
-- 10. AUDIT LOG TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id UUID,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.audit_log IS 'Audit trail for admin actions';

-- ============================================================================
-- 11. PAYMENT ATTEMPTS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.payment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    paystack_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('initiated', 'success', 'cancelled', 'failed', 'retry')),
    error_message TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.payment_attempts IS 'Log of payment attempts for debugging';

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Profiles indexes
CREATE INDEX IF NOT EXISTS idx_profiles_status ON public.profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_member_no ON public.profiles(member_no);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);

-- Contributions indexes
CREATE INDEX IF NOT EXISTS idx_contributions_member_id ON public.contributions(member_id);
CREATE INDEX IF NOT EXISTS idx_contributions_year_month ON public.contributions(year, month);
CREATE INDEX IF NOT EXISTS idx_contributions_status ON public.contributions(status);

-- Transactions indexes
CREATE INDEX IF NOT EXISTS idx_transactions_member_id ON public.transactions(member_id);
CREATE INDEX IF NOT EXISTS idx_transactions_paystack_ref ON public.transactions(paystack_ref);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON public.transactions(status);

-- Loans indexes
CREATE INDEX IF NOT EXISTS idx_loans_member_id ON public.loans(member_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON public.loans(status);

-- Messages indexes
CREATE INDEX IF NOT EXISTS idx_messages_member_id ON public.messages(member_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON public.messages(status);

-- Notifications indexes
CREATE INDEX IF NOT EXISTS idx_notifications_member_id ON public.notifications(member_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON public.notifications(read);

-- Audit log indexes
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id ON public.audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON public.audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON public.audit_log(created_at);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dividends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;

-- Force RLS for table owners
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.contributions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.loans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.dividends FORCE ROW LEVEL SECURITY;
ALTER TABLE public.messages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.message_replies FORCE ROW LEVEL SECURITY;
ALTER TABLE public.notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE public.announcements FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payment_attempts FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

-- Profiles policies
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Admins have full access to profiles" ON public.profiles;

CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Admins have full access to profiles"
  ON public.profiles FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Contributions policies
DROP POLICY IF EXISTS "Users can view own contributions" ON public.contributions;
DROP POLICY IF EXISTS "Users can create own contributions" ON public.contributions;
DROP POLICY IF EXISTS "Users can update own pending contributions" ON public.contributions;

CREATE POLICY "Users can view own contributions"
  ON public.contributions FOR SELECT
  USING (auth.uid() = member_id);

CREATE POLICY "Users can create own contributions"
  ON public.contributions FOR INSERT
  WITH CHECK (auth.uid() = member_id);

CREATE POLICY "Users can update own pending contributions"
  ON public.contributions FOR UPDATE
  USING (auth.uid() = member_id AND status = 'pending');

-- Transactions policies
DROP POLICY IF EXISTS "Users can view own transactions" ON public.transactions;

CREATE POLICY "Users can view own transactions"
  ON public.transactions FOR SELECT
  USING (auth.uid() = member_id);

-- Loans policies
DROP POLICY IF EXISTS "Users can view own loans" ON public.loans;
DROP POLICY IF EXISTS "Users can create loan applications" ON public.loans;

CREATE POLICY "Users can view own loans"
  ON public.loans FOR SELECT
  USING (auth.uid() = member_id);

CREATE POLICY "Users can create loan applications"
  ON public.loans FOR INSERT
  WITH CHECK (auth.uid() = member_id);

-- Dividends policies
DROP POLICY IF EXISTS "Users can view own dividends" ON public.dividends;

CREATE POLICY "Users can view own dividends"
  ON public.dividends FOR SELECT
  USING (auth.uid() = member_id);

-- Messages policies
DROP POLICY IF EXISTS "Users can view own messages" ON public.messages;
DROP POLICY IF EXISTS "Users can create messages" ON public.messages;

CREATE POLICY "Users can view own messages"
  ON public.messages FOR SELECT
  USING (auth.uid() = member_id);

CREATE POLICY "Users can create messages"
  ON public.messages FOR INSERT
  WITH CHECK (auth.uid() = member_id);

-- Message replies policies
DROP POLICY IF EXISTS "Users can view message replies" ON public.message_replies;

CREATE POLICY "Users can view message replies"
  ON public.message_replies FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_replies.message_id
      AND m.member_id = auth.uid()
    )
  );

-- Notifications policies
DROP POLICY IF EXISTS "Users can view own notifications" ON public.notifications;
DROP POLICY IF EXISTS "Users can update own notifications" ON public.notifications;

CREATE POLICY "Users can view own notifications"
  ON public.notifications FOR SELECT
  USING (auth.uid() = member_id);

CREATE POLICY "Users can update own notifications"
  ON public.notifications FOR UPDATE
  USING (auth.uid() = member_id);

-- Announcements policies
DROP POLICY IF EXISTS "Anyone can view published announcements" ON public.announcements;
DROP POLICY IF EXISTS "Admins can manage announcements" ON public.announcements;

CREATE POLICY "Anyone can view published announcements"
  ON public.announcements FOR SELECT
  USING (published = true);

CREATE POLICY "Admins can manage announcements"
  ON public.announcements FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Audit log policies
DROP POLICY IF EXISTS "Admins can view audit log" ON public.audit_log;

CREATE POLICY "Admins can view audit log"
  ON public.audit_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Payment attempts policies
DROP POLICY IF EXISTS "Users can view own payment attempts" ON public.payment_attempts;

CREATE POLICY "Users can view own payment attempts"
  ON public.payment_attempts FOR SELECT
  USING (auth.uid() = member_id);

-- ============================================================================
-- TRIGGERS FOR UPDATED_AT
-- ============================================================================

-- Function to automatically update updated_at
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at trigger to tables
DROP TRIGGER IF EXISTS handle_profiles_updated_at ON public.profiles;
CREATE TRIGGER handle_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS handle_contributions_updated_at ON public.contributions;
CREATE TRIGGER handle_contributions_updated_at
  BEFORE UPDATE ON public.contributions
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS handle_loans_updated_at ON public.loans;
CREATE TRIGGER handle_loans_updated_at
  BEFORE UPDATE ON public.loans
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS handle_messages_updated_at ON public.messages;
CREATE TRIGGER handle_messages_updated_at
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS handle_announcements_updated_at ON public.announcements;
CREATE TRIGGER handle_announcements_updated_at
  BEFORE UPDATE ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================================
-- PROFILE CREATION TRIGGER (for auth.users)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    full_name,
    status,
    role,
    onboarding_step,
    onboarding_done
  )
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      'New Member'
    ),
    'pending',
    'member',
    1,
    false
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop if exists and recreate trigger
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- MEMBER NUMBER GENERATION TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION public.generate_member_number()
RETURNS TRIGGER AS $$
DECLARE
  next_number INTEGER;
  member_number TEXT;
BEGIN
  IF NEW.status = 'active' AND NEW.member_no IS NULL AND
     (OLD.status IS DISTINCT FROM NEW.status) THEN

    SELECT COALESCE(MAX(
      CAST(NULLIF(regexp_replace(member_no, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_number
    FROM public.profiles
    WHERE status = 'active' AND member_no IS NOT NULL;

    member_number := 'DOMICOOP-' || LPAD(next_number::TEXT, 4, '0');

    WHILE EXISTS (
      SELECT 1 FROM public.profiles
      WHERE member_no = member_number AND id != NEW.id
    ) LOOP
      next_number := next_number + 1;
      member_number := 'DOMICOOP-' || LPAD(next_number::TEXT, 4, '0');
    END LOOP;

    NEW.member_no := member_number;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_member_approved ON public.profiles;

CREATE TRIGGER on_member_approved
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'active')
  EXECUTE FUNCTION public.generate_member_number();

-- ============================================================================
-- AUDIT LOGGING TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION public.log_profile_changes()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.audit_log (actor_id, action, entity, entity_id, metadata)
    VALUES (
      auth.uid(),
      'profile_status_change',
      'profiles',
      NEW.id,
      jsonb_build_object(
        'old_status', OLD.status,
        'new_status', NEW.status,
        'changed_at', NOW()
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_profile_status_change ON public.profiles;

CREATE TRIGGER on_profile_status_change
  AFTER UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.log_profile_changes();
