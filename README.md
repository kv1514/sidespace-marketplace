# SideSpace — Vercel + Supabase

This is the canonical Next.js application repository for SideSpace. The
repository root is the deployable app, so the existing Sites deployment can
remain online independently during the migration.

## Current deployment

- Public app: https://sidespace.ad
- Vercel deployment: https://sidespace-marketplace.vercel.app
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
   - set the Site URL to `https://sidespace.ad`;
   - add `http://localhost:3000/auth/callback`, `https://sidespace.ad/auth/callback`,
     and the `*.vercel.app` callback URL to Redirect URLs;
   - enable Google and add its client ID and secret if Google sign-in is wanted.
4. Copy `.env.example` to `.env.local` and add the Supabase values. Add only
   Stripe sandbox/test keys for the marketplace integration; never commit them.
5. Install and run:

   ```bash
   pnpm install
   pnpm dev
   ```

## Deploy to Vercel

Import the existing Git repository in Vercel and leave **Root Directory** at
the repository root (`.`). Add these environment variables for Production,
Preview, and Development:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only)
- `FOUNDER_AUTH_USER_IDS` (server-only; comma-separated immutable Supabase
  Auth user IDs for the founder KPI dashboard)
- `ANALYTICS_HASH_SECRET` (server-only; long random secret for deduplicated
  listing-view hashes)
- `SLACK_SIGNING_SECRET`, `SLACK_TEAM_ID`, and `SLACK_ALLOWED_USER_IDS`
  (server-only; only when enabling the founder slash command documented in
  `docs/SLACK_ADMIN_BOT.md`)
- Stripe variables documented in `docs/STRIPE_MARKETPLACE.md`

The founder KPI dashboard is documented in
[docs/FOUNDER_KPIS.md](docs/FOUNDER_KPIS.md). It is available at `/founder`
only to the two configured Supabase Auth user IDs.

Deploy, then add the production callback URL to Supabase:

`https://YOUR-DOMAIN/auth/callback`

Production traffic should use `https://sidespace.ad`. Connect that domain in
Vercel (Domains → Add) and point DNS as Vercel instructs. Keep
`NEXT_PUBLIC_APP_URL=https://sidespace.ad` on the Production environment so
Stripe Checkout, Connect return URLs, and same-origin payment checks match
the public hostname. The generated `*.vercel.app` address can stay as a
fallback.

## Languages

The interface speaks English, Spanish, French, Simplified Chinese, Korean, and
Vietnamese. The language is picked from the `sidespace_locale` cookie, then
from the browser's `Accept-Language`, and members change it from the language
and region dialog in the header. Listings, messages, and profiles stay as their
authors wrote them, and the legal pages are English only with a notice.

- `lib/i18n.ts` is the API: `translate(locale, key)`, the `t()` and `tx()`
  helpers that `useLocale()` hands to client components, and the formatters.
- `lib/i18n-messages/` holds one table per language, keyed by dotted names
  such as `chrome.signIn`. English is the source of truth; every other table
  must carry every key, which TypeScript enforces.
- Copy written as a literal in a component goes through `t("ns.key")`. Copy
  that reaches the screen as data - a toast, a validation message, a label in
  a module-level constant, a sentence an API route or the database sends back -
  stays English in the source and is translated by value with `tx()`, which
  looks the English up in the table.
- `node scripts/i18n-keys.mjs` lists every sentence the source can show that
  has no key, keys nothing references, and translations whose placeholders
  drifted from the English. `tests/i18n.test.ts` fails on the first and last.

## Security model

Passwords are stored and verified by Supabase Auth, not by the application.
The public browser receives only the Supabase publishable key. PostgreSQL
row-level-security policies enforce ownership for profiles and listings and
participant access for conversations and messages.
