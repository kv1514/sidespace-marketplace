# SideSpace Stripe marketplace integration

This implementation is intentionally test-mode-first. It uses Stripe Checkout,
Connect Express accounts, one-time invoice creation, and Stripe Tax for a
two-sided advertising marketplace. It does not contain keys, create live-mode
resources, or treat a browser redirect as proof of payment.

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
authenticated profile and returns an exact allowlisted Stripe-hosted Account
Link. Calling it again resumes incomplete onboarding for that same account.
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
  checkout attempt, refund total, delivery/review timestamps, payout lifecycle,
  and status needed for reconciliation.
- `payment_issues` stores one payer-reported issue per transaction;
  `payment_fulfillment_events` is an append-only transition history;
  `payment_resolution_actions` records idempotent staff refund operations; and
  `staff_members` is the explicit payments-admin allowlist.
- `payment_refunds` and `payment_disputes` preserve Stripe object-level history.
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
STRIPE_CONNECT_COUNTRY=US
STRIPE_CAMPAIGN_TAX_CODE=txcd_20030000
STRIPE_SERVICE_FEE_TAX_CODE=txcd_20030000
NEXT_PUBLIC_APP_URL=http://localhost:3000
CRON_SECRET=replace-with-a-long-random-server-secret
```

The publishable key enables Stripe status UI. Hosted Checkout does not expose
the secret key to the browser. `lib/stripe/server.ts` rejects every key that is
not prefixed `sk_test_`.

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

For a hosted webhook endpoint, subscribe to both platform and connected-account
events. Keep the signing secret environment-specific.

## Required webhook events

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
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

The Checkout events authoritatively reconcile successful, asynchronous,
failed, and expired Sessions. Refund events reconcile Charge refund totals.
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
   `/api/cron/release-payouts` every minute. The endpoint requires
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
- expired and asynchronous payment events;
- a `Business brief`, where the listing owner must be the payer;
- connected account requirements becoming incomplete;
- full and partial refunds; and
- dispute creation, update, win, and loss.

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
`paid`/`confirmed`, while a lost dispute stays disputed for operator review.
Because SideSpace is liable for disputes and Stripe fees, operators must
reconcile negative platform balances and any already-released Creator transfer.
The webhook records the dispute state and blocks an unreleased payout; it does
not assume that funds already paid to a connected account can be recovered.

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
6. Put that endpoint's environment-specific `whsec_...` value in the matching
   server environment. Never reuse the local listener secret in a deployment.

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
  `vercel.json` schedules it every minute, but the deployed scheduler and secret
  must be verified in the target environment before automatic release is
  considered operational.

Before a public launch, add application or edge rate limits to the three Stripe
mutation routes, stage a Content Security Policy in report-only mode, and only
enable HSTS after every production subdomain is confirmed HTTPS-only. Verify
these controls against the deployed response headers rather than assuming the
framework configuration reached the edge.

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
```

Passing static and database checks does not prove a real Stripe payment. A complete sandbox
sign-off additionally requires local test keys, a running webhook listener, a
fully onboarded sandbox connected account, a test Checkout, and verification of
the resulting Stripe balance transactions.

## Production launch checklist

- Complete the sandbox walkthrough, including delayed transfer, scheduled
  release, tax, refund, dispute, duplicate, asynchronous, and incomplete-
  onboarding cases; reconcile Stripe balances to the SideSpace ledger.
- Obtain legal/accounting approval for merchant-of-record, tax, refund,
  chargeback, KYC, data-retention, and supported-country obligations.
- Configure production Connect, payment methods, Tax registrations/codes,
  branding, support contact, statement descriptor, and platform bank account.
- Add edge/application rate limits, stage and enforce CSP, verify HSTS and all
  security headers, configure log redaction/alerting, and define failed-webhook
  replay and financial-reconciliation ownership.
- Apply reviewed migrations and server-only secrets through the normal release
  process. Rotate any key ever exposed outside its secret manager.
- Replace the test-mode code guard only in a separately reviewed launch change;
  deploy to a non-production environment first and run a final test-mode smoke
  test there.
- Do not enable live payments until the reviewed commit, deployment, webhook
  endpoint, database migration parity, rollback plan, and operator runbook are
  all explicitly signed off.
