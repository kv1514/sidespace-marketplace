# SideSpace — Vercel + Supabase

This is the production-ready Next.js version of SideSpace. It is intentionally
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

## Local setup

1. Create a Supabase project.
2. Open the Supabase SQL editor and run
   `supabase/migrations/0001_initial.sql`.
3. In Supabase Authentication:
   - set the Site URL to the final Vercel domain;
   - add `http://localhost:3000/auth/callback` and the Vercel callback URL to
     Redirect URLs;
   - enable Google and add its client ID and secret if Google sign-in is wanted.
4. Copy `.env.example` to `.env.local` and add the project URL and publishable
   key.
5. Install and run:

   ```bash
   npm install
   npm run dev
   ```

## Deploy to Vercel

Import the existing Git repository in Vercel and set **Root Directory** to
`vercel-app`. Add these environment variables for Production, Preview, and
Development:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

Deploy, then add the production callback URL to Supabase:

`https://YOUR-DOMAIN/auth/callback`

The generated `*.vercel.app` address is a normal public website. A custom domain
can be connected later in Vercel without changing the application.

## Security model

Passwords are stored and verified by Supabase Auth, not by the application.
The public browser receives only the Supabase publishable key. PostgreSQL
row-level-security policies enforce ownership for profiles and listings and
participant access for conversations and messages.
