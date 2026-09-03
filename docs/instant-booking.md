# Calendar availability and instant booking

Sellers enable instant booking in first-listing setup or the listing editor. Each listing has selected calendar dates, an IANA time zone, a fixed package length, fixed price, deliverables, and cancellation terms. Selection is capped at 365 days ahead; the entire package must fit inside selected consecutive dates and the horizon. Lead time is enforced in the listing's time zone. Calendars for different Creator offer types are independent.

Businesses choose one available start date and continue directly to Stripe Checkout. The server reserves the dates and creates an accepted campaign with the listing's stored price and terms. No seller acceptance is needed. Custom offers remain available. Existing listings opt in explicitly; the migration leaves instant booking disabled by default.

## Reservation lifecycle

- Both instant reservations and custom-offer acceptance lock the listing row before checking conflicts. Reservations also account for existing accepted, confirmed, completed, and disputed campaigns.
- Unstarted holds last 30 minutes. Once checkout begins, the reservation stays pinned through uncertain API results. Stripe receives a persisted 45-minute expiration so idempotent retries use the same parameters.
- Provider-verified expiration or a definitive rejected creation releases the hold. A local timer never releases a started checkout. An ambiguous creation can be resumed through the existing campaign in Dashboard.
- Full refunds release dates; partial refunds and disputes do not.
- Browser clients cannot call the reservation/checkout-claim RPCs. The server supplies the authenticated buyer ID; price and deliverables come from the locked listing. A stale listing version requires the buyer to review the updated terms.
- Payment webhooks confirm the campaign. The notification outbox then receives confirmation notices for both parties; unpaid holds do not generate the legacy acceptance-request email.

## Release

Apply `supabase/migrations/20260903003852_listing_instant_booking.sql` before releasing the application code. It depends on the existing book-as-listed migration `20260903002331`. The new public listing columns and checkout query require this schema. No production migration or deployment was performed for this change.

The local test database also needed the existing `20260901163842_payment_security_policy_cleanup.sql` reapplied to remove an obsolete SELECT policy. This is already in repository history, not a new schema requirement.

Validation: 200 application tests passed; 44 focused database checks cover permissions, fixed terms, dates, holds, provider expiration, notifications, and refunds. A separate two-session database race admitted one buyer and rejected the concurrent buyer. Browser checks covered 390px mobile layout, date/total selection, authenticated seller save/reopen, and dashboard text centering. TypeScript, production build, and lint (existing warnings only) passed. Stripe test/live route tests use mocks; no real payment was made. Seller Connect readiness and existing production payment gates still apply.
