# SideSpace Stripe marketplace integration

This implementation is test-mode-first with an explicit live-mode gate. It uses Stripe Checkout,
Connect Express accounts, one-time invoice creation, and Stripe Tax for a
two-sided advertising marketplace. It does not contain keys, create live-mode
resources during build or migration, or treat a browser redirect as proof of
payment. Live keys work only when the legal, tax, operations, and live-runtime
flags are all explicit; new Checkout Sessions have a separate kill switch so
webhooks and reversals can keep running during rollback.

## Money model

All money is stored and calculated in integer cents. `lib/payments/fees.ts` is
the single fee implementation.

| $100 campaign | Amount |
| --- | ---: |
| Campaign subtotal | $100.00 |
| Business fee (5%) | $5.00 |
| Business total before tax | $105.00 |
| Creator fee (5%) | $5.00 |
| Creator earnings | $95.00 |
| SideSpace gross revenue before Stripe fees | $10.00 |

Each 5% fee is rounded independently to the nearest cent. Stripe processing
fees are paid by the platform and are not deducted from the displayed creator
earnings.

An invited Business can receive one $5 onboarding ad credit from the shared
`?ref=SIDESPACE5` referral link. On a $100 campaign, the original Business total
remains $105, the credit reduces the actual pre-tax Stripe charge to $100, and
the Creator still earns $95. The credit is a promotional ledger entry keyed by
normalized authenticated email: it cannot be withdrawn, transferred, or used to
reduce Creator payout.

## Architecture

- The browser sends only a `campaignRequestId` to
  `POST /api/stripe/checkout`.
- The server reloads the listing, accepted campaign amount, participants, and
  creator Stripe account from Supabase. Browser amounts and account IDs are
  ignored because they are never accepted as inputs.
- A normal supply listing makes the requester the business payer and listing
  owner the creator payee. A `Business brief` reverses that direction: the
  listing owner pays and the requester earns.
- Accepted terms snapshot `accepted_subtotal_cents`, `payer_profile_id`, and
  `payee_profile_id`. A unique ledger row then snapshots every fee and party.
- The shared `?ref=SIDESPACE5` referral link can mint one $5 Business ad-credit
  grant per normalized authenticated email after completed Business onboarding.
  Legacy `?p=<PROSPECT_ID>` DEMAND links delegate to the same email-keyed claim.
  Checkout reserves the balance in the server-only ledger, and expiry or a
  failed Checkout releases it.
- `payment_transactions.customer_total_cents` preserves the original pricing
  snapshot; generated `charged_total_cents` is the pre-tax amount Stripe must
  collect after reserved ad credit. The Creator payout is unchanged.
- Checkout creates a platform charge. It does not set `transfer_data` or create
  an application fee, so the Creator's 95% share remains pending on the
  SideSpace platform after customer payment.
- Stripe Tax uses platform liability and collected tax stays on the platform
  charge. No tax transfer reversal is needed for new payments.
- The verified paid webhook records `status = paid`,
  `workflow_status = paid_payout_pending`, and `payout_status = pending`.
- After the Creator marks delivery, the database records one server timestamp
  and a deadline exactly 72 hours later. Payer confirmation or the protected
  server cron atomically claims release, then creates a separate Connect
  transfer for the trusted `payout_amount_cents`.
- Transfer creation uses `source_transaction`, a deterministic transfer group,
  and the Stripe idempotency key `sidespace-payout-{transactionId}`. A retry
  after an uncertain response returns the same transfer rather than paying
  twice.
- `invoice_creation.enabled` creates a one-time post-payment invoice/receipt.
  Net terms and accounts-receivable invoicing are deliberately out of scope.
- A verified, test-mode Stripe webhook is the only payment authority. Success
  and cancel URLs display status but never fulfil work.

## Transaction diagram

```text
Business
  |  $100 subtotal + $5 buyer fee + applicable tax
  v
Stripe platform charge owned by SideSpace
  |  $95 remains pending while work is completed
  |  $10 marketplace revenue and collected tax remain on the platform
  v
Delivery -> payer confirmation or 72-hour server deadline
  |
  v
Separate Connect transfer sends $95 to the Creator Express account

SideSpace gross marketplace revenue: $10 before Stripe fees
Stripe processing costs: paid by SideSpace
```

## Connect onboarding

`POST /api/stripe/connect/onboard` creates at most one Express account for the
authenticated Creator-capable profile and returns an exact allowlisted
Stripe-hosted Account Link. Calling it again resumes incomplete onboarding for
that same account. Creator capability may be the primary or secondary profile
role; legacy physical-space and sponsorship-host roles remain accepted during
the role-consolidation rollout. The checkout route independently verifies that
the trusted campaign payee is Creator-capable before it creates a charge.
`GET /api/stripe/connect/status` refreshes capability and requirement state;
checkout rechecks the account directly with Stripe. Once onboarding is ready,
`POST /api/stripe/connect/login` opens the account's Stripe-hosted Express
Dashboard so the creator can update payout information without exposing bank
details to SideSpace.

## Database records

- `stripe_accounts` stores the minimum customer/connected-account identifiers
  and capability state for each profile.
- `payment_transactions` is one immutable-money ledger snapshot per campaign.
  It stores every fee, party, Stripe lifecycle identifier, tax withholding,
  original and post-credit checkout totals, checkout attempt, refund total,
  delivery/review timestamps, payout lifecycle, and status needed for
  reconciliation.
- `business_ad_credit_referral_codes` and
  `business_ad_credit_referral_redemptions` hold the shared code and one-time
  email-keyed Business claim. `business_ad_credit_ledger` holds append-only
  grant reservations/releases or refund restorations. They are not readable or
  writable from the browser and expose no withdrawal path.
- `payment_issues` stores one payer-reported issue per transaction;
  `payment_fulfillment_events` is an append-only transition history;
  `payment_resolution_actions` records idempotent staff refund operations; and
  `staff_members` is the explicit payments-admin allowlist.
- `payment_refunds` and `payment_disputes` preserve Stripe object-level history.
- `payment_transfer_reversals` records cumulative, idempotent recovery attempts
  when a refund or lost dispute follows a released Creator transfer.
- `stripe_webhook_events` provides retry claims and event-ID idempotency.
- `creator_portfolio_items` provides public Creator work samples, while
  `creator_reviews` accepts one immutable payer review only after a verified
  campaign payout has completed.

Those columns support GMV, completed campaigns, active/repeat buyers and
creators, average order value, both fee streams, refunds, gross marketplace
revenue, and date-based reporting without reconstructing historical fees from
today's pricing constants.

SideSpace currently permits multiple campaign requests against a listing; it
does not model each listing as exclusive inventory. The payment uniqueness
boundary is therefore one transaction per accepted campaign request. If the
product later introduces exclusive time slots, add an atomic reservation keyed
to that inventory unit before enabling checkout rather than treating a listing
row itself as sold out.

## Environment

Copy `.env.example` to `.env.local` and set:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-local-publishable-key
SUPABASE_SERVICE_ROLE_KEY=your-local-server-secret

NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
# For hosted Stripe Connect webhooks, use that endpoint's separate secret.
# The local Stripe CLI listener uses one secret for both forwards.
# STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...
STRIPE_CONNECT_COUNTRY=US
STRIPE_CAMPAIGN_TAX_CODE=txcd_20030000
STRIPE_SERVICE_FEE_TAX_CODE=txcd_20030000
NEXT_PUBLIC_APP_URL=http://localhost:3000
CRON_SECRET=replace-with-a-long-random-server-secret
PAYMENTS_MONITORING_SECRET=replace-with-a-different-long-random-server-secret
```

The publishable key enables Stripe status UI. Hosted Checkout does not expose
the secret key to the browser. `lib/stripe/server.ts` rejects every key that is
not a recognized test or live secret, rejects mixed publishable/secret modes,
rejects live mode until every approval flag is true, and requires distinct
platform and Connect webhook secrets when the Stripe key is live. Live keys
are accepted only in Vercel Production, never in local development or a Vercel
Preview environment.

Do not paste keys into source, tests, chat, or committed env files. Rotate a key
immediately if it is exposed.

## Local setup

1. Start Docker Desktop.
2. Run `supabase start`, then `supabase db reset` from the app directory.
3. Copy the local Supabase values reported by `supabase status` into
   `.env.local`.
4. Copy test-mode Stripe API keys from the dedicated SideSpace sandbox into
   `.env.local`.
5. Start a local webhook forwarder:

   ```bash
   stripe listen \
     --forward-to localhost:3000/api/stripe/webhook \
     --forward-connect-to localhost:3000/api/stripe/webhook
   ```

6. Put the `whsec_...` printed by the listener in
   `STRIPE_WEBHOOK_SECRET`, then run `pnpm dev`.

For hosted webhooks, configure one platform endpoint and one Connect endpoint at
the same route, subscribe them to their respective event sets, and store both
environment-specific signing secrets. The local Stripe CLI listener can use one
secret for both forwards.

## Required webhook events

- `checkout.session.completed`
- `checkout.session.expired`
- `refund.created`
- `refund.updated`
- `refund.failed`
- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`
- `account.updated` for connected accounts

The event table provides idempotency. Failed events return HTTP 500 so Stripe
retries them. Previously failed or stale-processing events can be reclaimed;
processed event IDs return success without running twice.

Checkout enables cards only at launch, so the Checkout events authoritatively
reconcile successful and expired Sessions. The async handlers remain for
legacy or intentionally enabled future Sessions. Refund events reconcile
Charge refund totals and, after payout, queue a cumulative transfer reversal.
Dispute events track the chargeback lifecycle. `account.updated` refreshes only
the matching connected account's capability state. No browser redirect is
allowed to advance financial state.

## Delivery, review, and issue flow

1. Customer payment is verified by the Stripe webhook. The campaign is paid,
   but the Creator payout is pending.
2. Only the payee can choose **Mark campaign delivered**. The database writes
   `delivered_at` and `review_deadline = delivered_at + 72 hours` in one lock.
3. Before the deadline, only the payer can choose **Confirm work completed** or
   **Report an issue**. Reporting creates an immutable event and blocks payout.
4. **Resolve with the Creator** opens the existing campaign Messages thread.
   Escalation is rejected until both parties have messaged after the report.
5. Payer confirmation claims the payout atomically and creates the separate
   Stripe transfer. If no issue exists and the payer does nothing, Vercel calls
   `/api/cron/release-payouts` hourly. The endpoint requires
   `CRON_SECRET` and selects only deadlines at or before server time.
6. Authorized payments staff can resolve an escalated issue by releasing the
   payout, issuing a full refund, or issuing a partial refund. A partial refund
   proportionally adjusts the still-pending Creator payout from the immutable
   original earnings snapshot; after the verified refund webhook, the remainder
   is released through the same idempotent transfer path.

Confirmation, automatic release, issue reporting, and staff resolution all
lock the transaction row in database functions. Whichever valid transition
wins first changes the state seen by the others. A claimed transfer that fails
is returned to a retryable pending or blocked state with its error recorded.

## Sandbox walkthrough

1. Create two SideSpace users: one business and one creator.
2. As the creator, open Account settings and choose **Set up Stripe payouts**.
   Complete the Stripe-hosted Express onboarding with sandbox data.
3. Publish a creator listing priced at $100.00.
4. As the business, send a campaign request for $100.00.
5. As the creator, accept it. The campaign is accepted but not confirmed.
6. As the business, verify the summary shows campaign $100, buyer fee $5,
   total before tax $105. Choose **Pay securely with Stripe**.
7. Use Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC,
   and a valid billing address.
8. After the webhook arrives, confirm the ledger is `paid`, the campaign is
   `confirmed`, the Creator view says **Payout pending**, Stripe created a
   one-time invoice, and no Connect transfer exists yet.
9. As the Creator, choose **Mark campaign delivered**. Confirm the payer sees
   the exact deadline 72 hours later.
10. As the payer, choose **Confirm work completed**. Confirm exactly one
    separate transfer sends $95 to the stored connected account and the UI says
    **Payout released**.
11. Repeat with **Report an issue**, Messages, escalation, and each staff
    resolution. Confirm issue reporting prevents the cron from transferring.

Also exercise:

- decline card `4000 0000 0000 9995`;
- 3DS card `4000 0025 0000 3155`;
- cancel and resume an open Checkout Session;
- repeated Checkout button clicks (same open Session is reused);
- duplicate webhook delivery;
- expired card payment events;
- a `Business brief`, where the listing owner must be the payer;
- connected account requirements becoming incomplete;
- full and partial refunds; and
- dispute creation, update, win, and loss.

For the outreach-credit path, use the shared `?ref=SIDESPACE5` link, complete
Business onboarding, confirm the dashboard shows $5 available, and verify the
Checkout charge is reduced while the Creator earnings remain unchanged. Repeat
with the same email and confirm no second grant is created. Expire or cancel
before payment and confirm the reserved balance returns; complete a refund and
confirm the proportional promotional amount is restored.

## Refund and dispute operations

Issue refunds are created against the platform charge by the staff-only
resolution route. New charges have no destination transfer or application fee,
so destination-charge refund flags are deliberately not used. Full refunds
return the remaining customer charge and keep the Creator payout at zero.
Partial refunds calculate the reduced Creator payout from the immutable ledger
and release that remainder only after the refund webhook succeeds. Do not
create a second off-platform payment to simulate a refund.

Staff access is database-allowlisted and requires the `payments_admin` or
`admin` role. The webhook records each refund and updates the campaign and
ledger. Disputes are ingested
from Stripe and surface as `disputed`; a won dispute returns the payment to
`paid`/`confirmed`, while a lost dispute stays disputed for audit and queues
Creator-transfer recovery.
Because SideSpace is liable for disputes and Stripe fees, operators must
reconcile negative platform balances and any already-released Creator transfer.
After a succeeded refund or a lost dispute, the webhook and hourly cron attempt
an idempotent, cumulative transfer reversal. If a partial refund already reduced
the payout before release, the recovery only reverses the later incremental
delta. Stripe can reject that reversal
when the connected account has insufficient available balance; the recovery
remains failed/retryable and `/api/health/payments` stays unhealthy until it
succeeds or staff resolves it in Stripe and records the outcome.

## Stripe Dashboard setup

Perform these actions only in the dedicated SideSpace sandbox:

1. Copy the sandbox publishable and secret API keys into `.env.local`.
2. In Connect settings, complete the platform profile and enable Express
   connected accounts for the supported country (currently `US`).
3. In Payment methods, enable only methods compatible with platform charges
   and the supported business/creator regions. Checkout reads this setting
   dynamically.
4. In Tax, set the platform origin address, add only registrations SideSpace
   actually holds, and confirm both configured advertising/service tax codes.
5. For local work, use `stripe listen` as described above. For a hosted test
   endpoint, register `/api/stripe/webhook`, select the event list in this
   document, and enable connected-account events for `account.updated`.
6. Put the platform endpoint's `whsec_...` value in `STRIPE_WEBHOOK_SECRET` and
   the Connect endpoint's separate value in `STRIPE_CONNECT_WEBHOOK_SECRET`.
   Never reuse the local listener secret in a deployment.

## Tax gates

The integration calculates tax with SideSpace as the liable platform, but code
cannot decide where SideSpace is legally registered or which tax code applies
to every form of advertising. Before any live launch:

- have tax counsel/accounting confirm marketplace facilitator and seller-of-
  record treatment;
- activate the correct Stripe Tax registrations on the platform;
- confirm the campaign and service-fee tax codes;
- verify the platform head-office address and filing workflow;
- reconcile collected tax, separate transfers, reversals, refunds, and Stripe Tax reports;
  and
- test each supported jurisdiction and prohibit unsupported cross-border flows.

With no active registration, Stripe can legitimately calculate zero tax. A zero
amount is not evidence that tax setup is production-ready.

## Database and security notes

- `stripe_accounts`, payment ledgers, refund/dispute tables, and webhook events
  have RLS enabled and no `anon` or `authenticated` table grants. Server routes
  use a separate secret-key Supabase client.
- Authenticated clients cannot update campaign requests directly. The only
  browser-side pre-payment link is made through the locked
  `link_campaign_request_conversation` RPC, which verifies the requester and
  exact two-party conversation while leaving payment terms immutable.
- Users receive only a filtered transaction response; customer, connected
  account, Checkout, PaymentIntent, charge, transfer, application-fee, invoice,
  and webhook IDs remain server-only.
- Financial rows restrict deletion of referenced campaigns, listings, and
  profiles. Account deletion must retain or de-identify financial records rather
  than cascading them away.
- Stripe mutation routes require an authenticated member session and an exact
  same-origin request. UUID inputs are validated, hosted redirects are limited
  to exact HTTPS Stripe hosts, and authenticated financial responses use
  `private, no-store` caching.
- Checkout attempts use database compare-and-set state plus attempt-scoped
  Stripe idempotency keys. Webhook retry claims also use compare-and-set state,
  and a paid event can safely win a race before the checkout route stores the
  Session ID.
- The service-role key and Stripe secret key must be configured only in a
  server runtime. Never prefix either with `NEXT_PUBLIC_`.
- The scheduled release route also requires `CRON_SECRET`. The committed
  `vercel.json` schedules it hourly, but the deployed scheduler and secret
  must be verified in the target environment before automatic release is
  considered operational.

Payment and Connect mutations use a durable database rate limit shared by all
application instances. Before public launch, stage a Content Security Policy in
report-only mode, and only enable HSTS after every production subdomain is
confirmed HTTPS-only. Verify these controls and HTTP `429` behavior against the
deployed edge rather than assuming the framework configuration reached it.

## Inventory provenance gate

`listings.provenance_status` distinguishes `demo`, unknown legacy rows,
authenticated owner attestations, and independent staff verification. The
migration intentionally backfills every existing non-demo listing to
`unverified`; it never converts an unknown row into live inventory by guessing.
Those rows remain visible with a **view only** label. A listing becomes
requestable only after its authenticated owner saves or reactivates it, and
that attestation expires after 90 days. Demo, unverified, and stale listings
are blocked in the UI, campaign-request database trigger, RLS insert policy,
and Checkout route.

## Validation commands

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
supabase db reset
supabase test db
supabase db lint --local --level warning
pnpm audit --audit-level moderate
pnpm payments:preflight
```

Passing static and database checks does not prove a real Stripe payment. A complete sandbox
sign-off additionally requires local test keys, a running webhook listener, a
fully onboarded sandbox connected account, a test Checkout, and verification of
the resulting Stripe balance transactions.

## Production launch checklist

- [ ] Complete the sandbox walkthrough, including delayed transfer, scheduled
  release, tax, refund, dispute, duplicate, card failure, and incomplete-
  onboarding cases; reconcile Stripe balances to the SideSpace ledger.
- [ ] Exercise a post-payout full refund, partial refund, and lost dispute;
  verify the transfer reversal amount, retry behavior, and health alert.
- [ ] Obtain named legal/accounting approval for merchant-of-record, tax, refund,
  chargeback, KYC, data-retention, and supported-country obligations.
- [ ] Configure production Connect, card payment method, Tax registrations/codes,
  branding, support contact, statement descriptor, and platform bank account.
- [ ] Confirm the production database does not reuse sandbox Stripe object IDs;
  re-onboard every Creator and create live Customers/Checkout Sessions with the
  live key.
- [x] Apply durable application rate limits and fail-closed listing provenance.
- [ ] Stage and enforce CSP, verify HSTS and all security headers at the deployed
  edge, and configure the external monitor for `/api/health/payments`.
- [x] Define failed-webhook replay, payout reconciliation, monitoring ownership,
  and rollback in `PAYMENTS_RUNBOOK.md`.
- [ ] Apply reviewed migrations and server-only secrets through the normal release
  process. Rotate any key ever exposed outside its secret manager.
- [x] Add a separately reviewed, fail-closed live-mode gate and independent
  Checkout kill switch; keep all live flags false outside Production.
- [ ] Run `pnpm payments:preflight:live`, then a final test-mode smoke in the
  deployment candidate and the low-value live smoke in `PAYMENTS_RUNBOOK.md`.
- [ ] Do not enable live payments until the reviewed commit, deployment, webhook
  endpoint, database migration parity, rollback plan, and operator runbook are
  all explicitly signed off.
