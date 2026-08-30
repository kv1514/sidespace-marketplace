# SideSpace — Vercel + Supabase

This is the Next.js version of SideSpace. It is intentionally
kept in `vercel-app/` so the existing Sites deployment can remain online during
the migration.

## Current deployment

- Public app: https://sidespace-marketplace.vercel.app
- Supabase project: `jlomjbixyemqsruycycz`
- Database migration and auth redirect configuration are applied
- Email/password signup is live
- Google sign-in appears automatically after Google OAuth is enabled in
  Supabase; Google Cloud currently requires account MFA before those credentials
  can be created

## Included

- Public marketplace browsing without an account
- Email/password accounts through Supabase Auth
- Google sign-in support through Supabase Auth when the provider is enabled
- Four-role onboarding: campaign shopper, business, creator, or space owner
- Persistent profiles and listings in Supabase Postgres
- Private, row-level-secured conversations and realtime messages
- Responsive marketplace UI with realistic seeded sample content
- Clearly labeled demo members with a one-time automated sample reply
- Vercel-compatible Next.js App Router configuration
- Test-mode Stripe Checkout, Connect Express payouts, one-time invoices, Stripe
  Tax, webhook reconciliation, and a durable marketplace payment ledger

See [docs/STRIPE_MARKETPLACE.md](docs/STRIPE_MARKETPLACE.md) for the money
model, local sandbox setup, webhook events, test cards, refund/dispute runbook,
and live-launch gates.

## Local setup

1. Create a Supabase project, or run the local stack with Docker using
   `supabase start`.
2. Apply every migration in order with `supabase db reset` locally or the
   repository's normal Supabase migration deployment workflow. Do not run only
   the initial migration.
3. In Supabase Authentication:
   - set the Site URL to the final Vercel domain;
   - add `http://localhost:3000/auth/callback` and the Vercel callback URL to
     Redirect URLs;
   - enable Google and add its client ID and secret if Google sign-in is wanted.
4. Copy `.env.example` to `.env.local` and add the Supabase values. Add only
   Stripe sandbox/test keys for the marketplace integration; never commit them.
5. Install and run:

   ```bash
   pnpm install
   pnpm dev
   ```

## Deploy to Vercel

Import the existing Git repository in Vercel and set **Root Directory** to
`vercel-app`. Add these environment variables for Production, Preview, and
Development:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only)
- Stripe variables documented in `docs/STRIPE_MARKETPLACE.md`

Deploy, then add the production callback URL to Supabase:

`https://YOUR-DOMAIN/auth/callback`

The generated `*.vercel.app` address is a normal public website. A custom domain
can be connected later in Vercel without changing the application.

## Security model

Passwords are stored and verified by Supabase Auth, not by the application.
The public browser receives only the Supabase publishable key. PostgreSQL
row-level-security policies enforce ownership for profiles and listings and
participant access for conversations and messages.
