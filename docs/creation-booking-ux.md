# Creation and booking UX — local review

The shared listing editor replaces the long creation form with three sections. First-time profiles proceed into this same editor. Business briefs use What you need, Budget, and Timing. Optional descriptions, card text, audience, targeting, installation, tiers, and AI/voice assistance remain available. Photo uploads and offer drafts survive switching between online, physical, and sponsorship offers.

## Booking contract

- `listings.timing_kind`: `deadline` or `date_range`. NULL retains legacy semantics.
- `listings.pricing_kind`: `fixed`, `day`, `week`, or `30_days`. NULL retains the saved legacy unit and package terms.
- `minimum_duration_days`: defaults to one. Existing `booking_duration_days` remains the fixed-package duration.
- Requests snapshot timing, pricing, cancellation, timezone, notice, minimum duration, package duration, and listing version in immutable fields. Deadline requests use the same value for the existing start/end columns.
- `POST /api/listings/quote` accepts `listingId`, `startDate`, `endDate`, and `listingUpdatedAt`. It reads the authoritative SQL quote and adds the existing service fees. It never creates a request or reservation. Client prices and identities are ignored.
- Checkout accepts both date endpoints. SQL locks the listing, rechecks availability/version, and snapshots the calculated amount. Retries must match both dates and the listing version.
- Weekly and 30-day rates multiply the complete inclusive interval before rounding once. $70/week for 10 days = $100 subtotal, $5 buyer fee, $105 before tax. A same-day booking = $10 subtotal. Quotes below the existing $0.50 payment minimum receive an explanation rather than an increased price.
- Deadline availability reserves the deadline only. Placement bookings validate every intervening day, minimum duration, notice in the listing timezone, availability bounds, conflicts, and the one-year horizon.

## Migration and release order

No production changes have been made. Apply the reviewed database changes **before** publishing dependent application code.

1. Confirm the inherited owner-view migration `20260903060000_security_invoker_owner_views.sql` is present/applied. This file was preserved without modification.
2. Apply the upstream `20260903073000_street_view_captured.sql` prerequisite if it is missing.
3. Apply `20260903073844_simplify_creation_booking.sql` in a transaction, then reload PostgREST schema. Do not run an indiscriminate linked database push if other migrations are pending.
4. Run the focused SQL and payment regression suites against the target staging environment, then publish the application in a separate approved release.

The additive migration leaves existing timing fields NULL, preserves accepted prices, retains the five-argument reservation RPC, and adds a six-argument overload. Public projections add only timing/pricing fields. The owner view keeps `security_invoker` and its owner-scoped helper. Private contact policies now use the existing owner helper, fixing setup writes without granting public access to `auth_user_id`. This follows [Supabase access-control guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

Local migrations were applied directly for verification; that does not add entries to the Supabase CLI migration ledger. The local database contains disposable UX and concurrency fixtures. Do not publish those fixtures or local credentials.

## Verification

- 239 application tests passed, including the full payment regression suite and new quote, tampering, payment minimum, rounding, deadline, boundary, and availability cases.
- 34 new SQL checks passed. Existing suites: instant booking 44/44, delayed payouts 45/45, promo checkout 30/30, transfer recovery 23/23, inherited owner-view security 12/12.
- Two simultaneous 10-day reservation transactions produced one success and one conflict.
- TypeScript and production build passed. Lint completed with no errors and seven existing warnings. `git diff --check` passed.
- Browser checks covered fresh Creator setup into the shared composer; social deadline creation/editing; weekly posters with installation details and photo upload; two sponsorship tiers; flexible business brief creation followed by a deadline/targeting edit; deadline and 10-day booking requests with matching dashboard summaries; same-day instant quote; native date inputs and the available-date calendar.
- Switching Online → Physical → Online retained entered answers. A selected poster photo and installation fields survived switching away and back. An invalid price range opened its collapsed section and focused the field.
- A legacy monthly listing retained its original monthly unit, 30-day package, full description, custom card summary, and hidden platform targeting after editing.
- Desktop 1440px and mobile 390px layouts were inspected. No horizontal page overflow was measured; the creation action remained visible.

The broader local database suite is **not fully green**: `launch_safety.test.sql` fails the authenticated internal-listing visibility assertion, and `slack_founder_admin.test.sql` fails the founder-audit RLS-enabled assertion. These unrelated policies were not changed by this work and remain release gates to investigate separately.

Real Stripe checkout, live payout onboarding, AI/voice provider calls, and live Street View retrieval were not exercised. Their existing code paths and payment tests remain; the local preview disables real payment calls.

## Local preview

The verified local preview runs at http://localhost:3100/marketplace using the local Supabase instance on port 54321. The temporary local launcher is `/tmp/sidespace-ux-local.py`; `UX_NEXT_COMMAND=build` builds and `UX_NEXT_COMMAND=start` serves the production bundle. It resolves local development keys without printing them and disables real Stripe calls. These temporary launcher files are not part of the release.
