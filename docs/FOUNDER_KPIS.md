# Founder KPI reporting

SideSpace has a private `/founder` dashboard and a matching
`/api/founder/kpis?days=30` JSON endpoint. Both are restricted to the
immutable Supabase Auth IDs listed in `FOUNDER_AUTH_USER_IDS`.

## Setup

1. Apply `supabase/migrations/20260904073000_founder_kpi_analytics.sql` through
   the normal migration workflow. Run it locally first with the rest of the
   schema.
2. Set `FOUNDER_AUTH_USER_IDS` on the server to the two founders'
   `auth.users.id` UUIDs, comma-separated. Do not use emails, display names, or
   Slack IDs because those can change or belong to another system.
3. Set `ANALYTICS_HASH_SECRET` to at least 32 random bytes of server-only
   secret material. Changing it later starts a new anonymous visitor namespace;
   it does not expose the old hashes or merge the two namespaces.
4. Visit `/founder` while signed in as one of those two accounts. Choose a
   7-, 30-, 90-, or 365-day UTC activity window.

The report is intentionally not linked from the public navigation. A
non-founder receives a not-found response, and the JSON endpoint returns no
KPI data without the allowlist and service-role database boundary.

## Metric definitions

- The current-state cards are an all-time snapshot. They exclude profiles and
  transactions marked `is_demo` or `is_internal`; suspended owners are excluded
  from active inventory.
- Listing views are server-recorded detail opens. A random first-party visitor
  cookie is HMAC-hashed and deduplicated once per listing per UTC day. No raw
  cookie value is stored in Postgres. The endpoint also has a bounded,
  best-effort per-client request guard; listing views remain directional
  product analytics and are not a financial control.
- New members, onboarding completion, listing publication, request sent,
  acceptance, and fulfillment are recorded by database triggers. The events
  are private, deduplicated, and cannot be written by browser roles.
- GMV is the original accepted listing subtotal (`subtotal_cents`) for payment
  rows verified as paid by Stripe reconciliation. It is not net revenue.
- Cash collected is the paid customer charge after promotional credits and
  before refunds, with tax shown separately. Platform gross revenue is the
  buyer fee plus creator fee before Stripe processing costs. Tax, credits, and
  refunds are separate values so they are not silently mixed into revenue.
- Pending creator payout is the trusted payout ledger amount in `pending`,
  `releasing`, or `blocked`. Released payout totals use the immutable payout
  amount and release state.
- Repeat businesses are real businesses with at least two verified paid
  campaigns. The period version counts businesses with at least two paid
  campaigns inside the selected window.
- Payment issues and disputes are current operational state, not period event
  counts. Payment status breakdowns are current rows for real participants.

## Historical accuracy boundary

The migration backfills signup, active-listing, request-sent, and fulfillment
facts only when an existing trustworthy timestamp already exists. Older
campaign rows do not retain the exact moment both sides accepted, so the
acceptance series starts when this migration is applied instead of assigning a
made-up historical date. The dashboard labels this boundary directly.

The report's money values are integer cents in Postgres and are formatted as
USD only at the presentation layer. Stripe/webhook reconciliation remains the
financial authority; browser analytics are never used to calculate money.

## Verification

Run the application checks and local database checks from the app directory:

```bash
pnpm typecheck
pnpm lint
supabase db reset
supabase test db
supabase db lint --local --level warning
```

This change does not apply a migration to the linked production project or
configure Vercel secrets automatically. Those are release steps after the
founder IDs and analytics secret have been reviewed.
