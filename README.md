# DOMICOOP API Server

> **Elysia on Bun — Backend API Server for DOMICOOP (Dominion Co-operative Society) Platform**

[![Bun](https://img.shields.io/badge/Bun-1.3+-black?style=flat&logo=bun)](https://bun.sh)
[![Elysia](https://img.shields.io/badge/Elysia-1.4+-black?style=flat)](https://elysiajs.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue?style=flat&logo=typescript)](https://typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-2.0+-3ECF8E?style=flat&logo=supabase)](https://supabase.com)

A high-performance backend API server built with [Elysia](https://elysiajs.com) on [Bun](https://bun.sh) for the DOMICOOP (Dominion Cooperative society platform). This server serves as the single point of communication between all clients (Expo mobile app and Next.js admin portal) and all data services (Supabase and Paystack).

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment Variables](#environment-variables)
- [Database Setup](#database-setup)
- [Email Configuration](#email-configuration)
- [Running the Server](#running-the-server)
- [API Documentation](#api-documentation)
- [Project Structure](#project-structure)
- [Deployment](#deployment)
- [Security](#security)
- [Contributing](#contributing)

## Features

### Core Functionality
- **Authentication & Authorization**: JWT-based auth with Supabase, role-based access control
- **Member Management**: Registration, profile management, KYC, onboarding workflow
- **Financial Operations**:
  - Monthly contributions tracking
  - Savings account management
  - Loan applications and repayment scheduling
  - Dividend distribution via Paystack Transfer
- **Payment Processing**: Paystack integration for secure payments
- **Communication**: Expo push notifications, in-app messaging, announcements
- **Admin Dashboard**: Member approval, contribution verification, loan processing, financial reports

### Key Features
- ✅ **Two-layer security**: Elysia middleware + Supabase RLS policies
- ✅ **Email authentication**: Secure email/password auth with verification
- ✅ **Paystack webhook HMAC-SHA512 signature verification**
- ✅ **Server-gated onboarding**: Tracks and enforces 3-step onboarding completion
- ✅ **Type-safe**: Full TypeScript with strict mode
- ✅ **Rate limiting**: Per-endpoint rate limiting for auth, payments, and general routes
- ✅ **Audit logging**: Complete audit trail for admin actions
- ✅ **Expo Push Notifications**: Real-time notifications to mobile devices
- ✅ **Account status enforcement**: Pending users blocked from financial operations

## Tech Stack

| Category | Technology |
|----------|------------|
| **Runtime** | [Bun](https://bun.sh) |
| **Framework** | [Elysia](https://elysiajs.com) |
| **Language** | [TypeScript](https://typescriptlang.org) |
| **Database** | [Supabase](https://supabase.com) (PostgreSQL) |
| **Auth** | Supabase Auth |
| **Payments** | [Paystack](https://paystack.com) |
| **Push Notifications** | Expo Push Notifications |
| **API Docs** | Swagger/OpenAPI (via @elysiajs/swagger) |

## Prerequisites

- [Bun](https://bun.sh) v1.3.10 or higher
- [Supabase](https://supabase.com) project
- [Paystack](https://paystack.com) business account
- [Expo](https://expo.dev) account (for push notifications)

## Installation

1. **Clone the repository**:
```bash
git clone https://github.com/YOUR_USERNAME/domicop-server.git
cd domicop-server
```

2. **Install dependencies**:
```bash
bun install
```

3. **Set up environment variables**:
```bash
cp .env.example .env
# Edit .env with your actual credentials
```

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Paystack
PAYSTACK_SECRET_KEY=sk_test_xxxx
PAYSTACK_PUBLIC_KEY=pk_test_xxxx
PAYSTACK_WEBHOOK_SECRET=your-webhook-secret

# Expo Push Notifications
EXPO_ACCESS_TOKEN=your-expo-access-token

# App
PORT=3000
NODE_ENV=development
API_BASE_URL=https://api.domicop.com
CLIENT_MOBILE_ORIGIN=exp://
CLIENT_ADMIN_ORIGIN=https://admin.domicop.com
```

### Getting the Credentials

- **Supabase**: Get from Project Settings → API in your Supabase dashboard
- **Paystack**: Get from Settings → API Keys & Webhooks in your Paystack dashboard
- **Expo**: 
  1. Go to https://expo.dev/accounts/[username]/settings/access-tokens
  2. Click "Create Token"
  3. Copy the generated token

## Database Setup

We now use Supabase migrations for database management. The schema includes all tables, RLS policies, triggers, and indexes.

### Option 1: Using Supabase CLI (Recommended)

```bash
# Link your project
supabase link --project-ref <your-project-ref>

# Push migrations
supabase db push
```

### Option 2: Using Supabase SQL Editor

If you prefer manual setup, run the migration files in order:
1. `supabase/migrations/20240601_initial_schema.sql` - Creates all tables
2. `supabase/migrations/20240615_oauth_and_rls_setup.sql` - OAuth triggers and RLS policies

Or run individual SQL statements:

### 1. Profiles Table (extends Supabase auth.users)
```sql
create table public.profiles (
  id              uuid references auth.users(id) on delete cascade primary key,
  full_name       text not null,
  phone           text,
  address         text,
  bank_name       text,
  bank_account    text,
  bank_code       text,
  next_of_kin     text,
  role            text not null default 'member' check (role in ('member', 'admin')),
  status          text not null default 'pending' check (status in ('pending', 'active', 'suspended')),
  onboarding_step int  not null default 0,
  onboarding_done boolean not null default false,
  expo_push_token text,
  push_notifications_enabled boolean default true,
  avatar_url      text,
  member_no       text unique,
  preferences     jsonb not null default '{
    "theme": "system",
    "notifications_enabled": true,
    "notification_types": {
      "payments": true,
      "loans": true,
      "announcements": true,
      "messages": true
    }
  }'::jsonb,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
```

### 2. Contributions Table
```sql
create table public.contributions (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid references public.profiles(id) on delete cascade not null,
  amount        numeric(12,2) not null,
  month         text not null,
  year          int  not null,
  status        text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  proof_url     text,
  payment_ref   text,
  notes         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
```

### 3. Transactions Table
```sql
create table public.transactions (
  id                uuid primary key default gen_random_uuid(),
  member_id         uuid references public.profiles(id) on delete cascade not null,
  paystack_ref      text unique not null,
  amount            numeric(12,2) not null,
  type              text not null check (type in ('contribution', 'loan_repayment', 'levy', 'dividend')),
  status            text not null default 'pending' check (status in ('pending', 'success', 'failed', 'reversed')),
  channel           text,
  description       text,
  contribution_id   uuid references public.contributions(id),
  loan_id           uuid references public.loans(id),
  metadata          jsonb default '{}',
  created_at        timestamptz default now()
);
```

### 4. Loans Table
```sql
create table public.loans (
  id                uuid primary key default gen_random_uuid(),
  member_id         uuid references public.profiles(id) on delete cascade not null,
  amount_requested  numeric(12,2) not null,
  amount_approved   numeric(12,2),
  purpose           text not null,
  type              text not null check (type in ('emergency', 'personal', 'housing', 'education', 'business')),
  status            text not null default 'pending'
                    check (status in ('pending', 'under_review', 'approved', 'rejected', 'disbursed', 'repaying', 'closed')),
  interest_rate     numeric(5,2)  default 5.00,
  tenure_months     int,
  monthly_repayment numeric(12,2),
  balance           numeric(12,2) default 0,
  disbursed_at      timestamptz,
  due_date          timestamptz,
  admin_notes       text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
```

### 5. Dividends Table
```sql
create table public.dividends (
  id                    uuid primary key default gen_random_uuid(),
  member_id             uuid references public.profiles(id) on delete cascade not null,
  amount                numeric(12,2) not null,
  year                  int not null,
  paystack_transfer_ref text,
  status                text not null default 'pending'
                        check (status in ('pending', 'processing', 'success', 'failed')),
  created_at            timestamptz default now()
);
```

### 6. Messages Table (Support Tickets)
```sql
create table public.messages (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid references public.profiles(id) on delete cascade not null,
  subject     text not null,
  status      text not null default 'open'
              check (status in ('open', 'in_progress', 'resolved', 'closed')),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table public.message_replies (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid references public.messages(id) on delete cascade not null,
  sender_id   uuid references public.profiles(id) not null,
  body        text not null,
  created_at  timestamptz default now()
);
```

### 7. Notifications Table
```sql
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid references public.profiles(id) on delete cascade not null,
  title       text not null,
  body        text not null,
  type        text not null check (type in ('payment', 'loan', 'announcement', 'message', 'general')),
  read        boolean not null default false,
  data        jsonb default '{}',
  created_at  timestamptz default now()
);
```

### 8. Announcements Table
```sql
create table public.announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null,
  author_id   uuid references public.profiles(id),
  published   boolean default false,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
```

### 9. Audit Log Table
```sql
create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.profiles(id),
  action      text not null,
  entity      text not null,
  entity_id   uuid,
  metadata    jsonb default '{}',
  created_at  timestamptz default now()
);
```

### 10. Enable RLS and Create Policies
```sql
-- Enable RLS
alter table public.profiles       enable row level security;
alter table public.contributions  enable row level security;
alter table public.transactions   enable row level security;
alter table public.loans          enable row level security;
alter table public.dividends      enable row level security;
alter table public.messages       enable row level security;
alter table public.message_replies enable row level security;
alter table public.notifications  enable row level security;

-- RLS helper function
create or replace function public.get_user_role()
returns text as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb->>'user_role', '')::text;
$$ language sql stable;

-- Profiles policies
create policy "member reads own profile"   on public.profiles for select using (id = auth.uid());
create policy "member updates own profile" on public.profiles for update using (id = auth.uid());
create policy "admin full access"          on public.profiles for all    using (get_user_role() = 'admin');

-- Contributions policies
create policy "member reads own"   on public.contributions for select using (member_id = auth.uid());
create policy "member inserts own" on public.contributions for insert with check (member_id = auth.uid());
create policy "admin full access"  on public.contributions for all    using (get_user_role() = 'admin');

-- Transactions policies
create policy "member reads own"  on public.transactions for select using (member_id = auth.uid());
create policy "admin full access" on public.transactions for all    using (get_user_role() = 'admin');

-- Loans policies
create policy "member reads own"   on public.loans for select using (member_id = auth.uid());
create policy "member applies"     on public.loans for insert with check (member_id = auth.uid());
create policy "admin full access"  on public.loans for all    using (get_user_role() = 'admin');

-- Notifications policies
create policy "member reads own"  on public.notifications for select using (member_id = auth.uid());
create policy "admin full access" on public.notifications for all    using (get_user_role() = 'admin');

-- Messages policies
create policy "member reads own"   on public.messages for select using (member_id = auth.uid());
create policy "member creates"     on public.messages for insert with check (member_id = auth.uid());
create policy "admin full access"  on public.messages for all    using (get_user_role() = 'admin');

-- Announcements policies
create policy "public reads published" on public.announcements for select using (published = true);
create policy "admin manages"          on public.announcements for all    using (get_user_role() = 'admin');
```

### 11. Storage Buckets
```sql
insert into storage.buckets (id, name, public) values
  ('kyc-docs',            'kyc-docs',            false),
  ('contribution-proofs', 'contribution-proofs', false),
  ('loan-docs',           'loan-docs',           false),
  ('avatars',             'avatars',             true);
```

### 12. Custom JWT Hook
```sql
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb as $$
declare
  claims          jsonb;
  user_role       text;
  onboarding_done boolean;
begin
  select role, onboarding_done
  into user_role, onboarding_done
  from public.profiles
  where id = (event->>'user_id')::uuid;

  claims := event->'claims';
  claims := jsonb_set(claims, '{user_role}',       to_jsonb(coalesce(user_role, 'member')));
  claims := jsonb_set(claims, '{onboarding_done}', to_jsonb(coalesce(onboarding_done, false)));
  return jsonb_set(event, '{claims}', claims);
end;
$$ language plpgsql stable security definer;
```

Register this under **Supabase Dashboard → Authentication → Hooks → Custom Access Token**.

## Email Configuration

### Enable Email Provider

1. Go to **Supabase Dashboard → Authentication → Providers**
2. Ensure **Email** provider is enabled
3. Configure email confirmation:
   - **Confirm email**: Enable (recommended for production)
   - **Secure email change**: Enable
   - **Secure password change**: Enable

### Email Templates

Supabase provides default email templates. To customize:

1. Go to **Authentication → Email Templates**
2. Customize templates for:
   - Confirmation email
   - Invitation email
   - Magic Link email
   - Email change confirmation
   - Password reset email

### SMTP Configuration (Recommended for Production)

For production, configure a custom SMTP provider:

1. Go to **Settings → Auth → Email**
2. Enable "Use custom SMTP server"
3. Enter your SMTP credentials (SendGrid, AWS SES, etc.)

Example with SendGrid:
- **Host**: `smtp.sendgrid.net`
- **Port**: `587`
- **Username**: `apikey`
- **Password**: Your SendGrid API key

### Environment Variable

Add to your `.env`:
```env
REQUIRE_EMAIL_VERIFICATION=true
```

## Running the Server

### Development Mode (with hot reload)
```bash
bun run dev
```

### Production Mode
```bash
bun run start
```

The server will start on `http://localhost:3000` (or the port specified in your `.env`).

### Verify Installation
```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2026-04-11T12:00:00.000Z",
  "env": "development"
}
```

## API Documentation

Once the server is running, visit:
- **Swagger UI**: `http://localhost:3000/swagger`
- **OpenAPI JSON**: `http://localhost:3000/swagger/json`

### API Endpoints Overview

#### Authentication (`/auth`)
- `POST /auth/register` - Create new account with email/password
- `POST /auth/login` - Member login with email/password
- `POST /auth/refresh` - Refresh access token
- `POST /auth/logout` - Logout
- `POST /auth/reset-password` - Request password reset
- `POST /auth/confirm-reset` - Confirm password reset with new password
- `POST /auth/resend-verification` - Resend verification email
- `POST /auth/change-password` - Change password (authenticated, requires current password)
- `POST /auth/expo-token` - Store Expo push notification token

#### Members (`/members`)
- `POST /members/register` - Register new member
- `GET /members/me` - Get current member profile
- `PATCH /members/me` - Update profile
- `GET /members/me/security` - Get security info
- `PATCH /members/me/preferences` - Update preferences

#### Admins (`/admins`)
Admin accounts live in the dedicated `admin_profiles` table, separate from member `profiles`. **A row in `admin_profiles` is what grants admin authorization** (the old `profiles.role = 'admin'` flag no longer does). All `/admins` routes require an existing admin.
- `GET /admins` - List all admins
- `POST /admins` - Create an admin `{ email, password, full_name, phone? }`
- `DELETE /admins/:id` - Revoke an admin (deletes the auth user; cannot revoke yourself)

Bootstrap the **first** admin (the API requires an existing admin, so this can't be done over HTTP):
```bash
bun run scripts/create-admin.ts <email> <password> "<full name>" [phone]
```

#### Dashboard (`/dashboard`)
- `GET /dashboard/summary` - Dashboard summary data

#### Contributions (`/contributions`)
- `GET /contributions/me` - List member contributions with balance summary & transactions
- `POST /contributions` - Add new contribution (non-admin submissions are stored as `pending`)
- `POST /contributions/verify` - Verify a Paystack payment server-side and record the contribution. Body: `{ reference, year, month, member_no?, member_email?, notes? }` — amount and status come from Paystack, never the client. Idempotent per reference (`already_processed: true` on replay).
- `GET /contributions/:id` - Get contribution details

#### Payments (`/payments`)
- `POST /payments/initiate` - Initiate payment
- `GET /payments/:ref/status` - Check payment status
- `GET /payments/me` - Get payment history

#### Loans (`/loans`)
- `GET /loans/me` - List member loans
- `POST /loans/apply` - Apply for loan
- `GET /loans/:id` - Get loan details
- `POST /loans/:id/repayment` - Apply a Paystack payment to the loan. Body: `{ reference }` only — the server verifies the transaction with Paystack and uses the verified amount. Replay-safe (unique `paystack_ref`).

#### Messages (`/messages`)
- `GET /messages/me` - Get support tickets
- `POST /messages` - Create support ticket
- `POST /messages/:id/reply` - Reply to ticket

#### Notifications (`/notifications`)
- `GET /notifications/me` - Get notifications
- `PATCH /notifications/me/read` - Mark as read

#### Announcements (`/announcements`)
- `GET /announcements` - Get published announcements

#### Webhook
- `POST /v1/webhooks/paystack` - Paystack webhook handler (HMAC-SHA512 signature required). Handles `charge.success` (confirms pending contributions independently of the app) and `transfer.success/failed/reversed` (loan disbursements). Set `PAYSTACK_WEBHOOK_SECRET` to the Paystack secret key — Paystack signs webhooks with it — and register the URL in the Paystack dashboard.

> **Payment verification is server-side.** Clients never send amounts or payment statuses for paid flows; they send only the Paystack `reference`, and this server verifies it with Paystack using the secret key. The Paystack secret key must never ship in a client bundle.

## Project Structure

```
domicop-server/
├── src/
│   ├── index.ts                 # Application entry point
│   ├── lib/
│   │   ├── supabase.ts          # Supabase clients
│   │   └── paystack.ts          # Paystack API integration
│   ├── middleware/
│   │   ├── authenticate.ts      # JWT authentication
│   │   ├── requireAdmin.ts      # Admin authorization
│   │   ├── validateWebhook.ts   # Paystack webhook validation
│   │   └── rateLimiter.ts       # Rate limiting
│   ├── routes/
│   │   ├── auth.ts              # Authentication routes
│   │   ├── members.ts           # Member management
│   │   ├── onboarding.ts        # Onboarding flow
│   │   ├── dashboard.ts         # Dashboard data
│   │   ├── savings.ts           # Savings operations
│   │   ├── contributions.ts     # Contributions management
│   │   ├── payments.ts          # Payment processing
│   │   ├── loans.ts             # Loan management
│   │   ├── dividends.ts         # Dividend distribution
│   │   ├── messages.ts          # Support tickets
│   │   ├── notifications.ts     # Push notifications
│   │   ├── announcements.ts     # Announcements
│   │   └── reports.ts           # Financial reports
│   ├── types/
│   │   ├── database.ts          # Database types
│   │   └── index.ts             # Shared types
│   └── utils/
│       ├── audit.ts             # Audit logging
│       └── validators.ts        # Validation helpers
├── .env                         # Environment variables
├── .env.example                 # Environment template
├── package.json                 # Dependencies
├── tsconfig.json                # TypeScript config
└── railway.toml                 # Railway deployment config
```

## Deployment

### Deploy to Railway

1. **Install Railway CLI**:
```bash
npm install -g @railway/cli
```

2. **Login to Railway**:
```bash
railway login
```

3. **Initialize project**:
```bash
railway init
```

4. **Add environment variables** in Railway dashboard:
   - Go to your project → Variables
   - Add all variables from `.env`

5. **Deploy**:
```bash
railway up
```

6. **Configure custom domain** (optional):
   - Go to Settings → Domains
   - Add `api.domicop.com`

### Configure Paystack Webhook

After deployment, configure the webhook URL in your Paystack dashboard:

**URL**: `https://api.domicop.com/payments/webhook`

## Security

- **Service Role Key**: Never expose the Supabase service role key to clients. It's only used server-side.
- **Webhook Validation**: Always verify Paystack webhook signatures using HMAC-SHA512.
- **RLS Policies**: Database rows are protected by Row Level Security policies.
- **Rate Limiting**: Auth (10/min), Payments (30/min), General (100/min).
- **Environment Variables**: Sensitive credentials are stored in environment variables, never committed to git.

## Development Workflow

### Type Checking
```bash
bun run lint
```

### Running Tests
```bash
bun test
```

### Code Style
- Follow existing code patterns
- Use TypeScript strict mode
- All routes must be fully typed
- Use Elysia's built-in validation with TypeBox

## License

[MIT](LICENSE)

## Support

For support, email nexahubt@gmail.com or open an issue on GitHub.

---

Built with ❤️ by Codex Technologies
