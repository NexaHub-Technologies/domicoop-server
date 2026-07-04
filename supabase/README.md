# Supabase Configuration

This directory contains database migrations and configuration for the DOMICOOP Supabase project.

## Database Migrations

### Running Migrations

To apply migrations to your Supabase project:

```bash
# Using Supabase CLI
supabase login
supabase link --project-ref <your-project-ref>
supabase db push

# Or using the SQL file directly in Supabase Dashboard
# Go to: SQL Editor → New Query → Paste migration content → Run
```

### Migration Files

- `20240601_initial_schema.sql` - Initial schema with tables, RLS policies, triggers

## Email Authentication Setup

### Prerequisites

1. Supabase project
2. SMTP provider (optional but recommended for production)

### Configuration Steps

1. **Enable Email Provider**:
   - Go to **Authentication → Providers**
   - Enable Email provider
   - Configure settings:
     - ✅ Confirm email: ON
     - ✅ Secure email change: ON
     - ✅ Secure password change: ON

2. **Configure SMTP** (Production):
   - Go to **Settings → Auth → Email**
   - Enable "Use custom SMTP server"
   - Enter your SMTP credentials

3. **Customize Email Templates**:
   - Go to **Authentication → Email Templates**
   - Customize:
     - Confirmation email
     - Password reset email
     - Magic Link email

### Email Verification Flow

1. User registers → Receives confirmation email
2. User clicks confirmation link
3. User can now login
4. If not verified → Login blocked with message

## Database Schema

### Tables

- `profiles` - Member profiles (extends auth.users)
- `contributions` - Monthly contributions
- `loans` - Loan applications
- `transactions` - Payment transactions
- `dividends` - Dividend distributions
- `messages` - Support tickets
- `notifications` - User notifications
- `announcements` - System announcements
- `audit_log` - Admin action audit trail

### Security Features

- ✅ RLS enabled on all tables
- ✅ Auto-profile creation on signup
- ✅ Member number generation on approval
- ✅ Account status enforcement
- ✅ Audit logging

## Troubleshooting

### Profile not created after signup

Check trigger exists:
```sql
SELECT * FROM pg_trigger WHERE tgname = 'on_auth_user_created';
```

### Email not sending

- Check SMTP configuration
- Check Supabase email rate limits
- Verify email templates are configured

## Support

For Supabase issues:
- Check [Supabase Documentation](https://supabase.com/docs)
- Review [Supabase Auth Guides](https://supabase.com/docs/guides/auth)
