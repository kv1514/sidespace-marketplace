# SideSpace payments operator runbook

This runbook is for the reviewed SideSpace production deployment. It does not
turn a local build or a Stripe sandbox test into legal or production approval.

## Launch order

1. Before applying anything, run `supabase migration list --linked` and
   `supabase db push --linked --dry-run`. If the hosted project has migration
   versions that are not present in this checkout, stop and reconcile the
   history/schema with a reviewed plan; never run `migration repair` blindly.
2. Keep `PAYMENTS_CHECKOUT_ENABLED=false` while applying the reviewed database
   migrations and server-only secrets.
3. Run `pnpm payments:preflight:live` in the production environment while
   Checkout remains disabled. Every check except the intentional
   `PAYMENTS_CHECKOUT_ENABLED` kill-switch check must pass.
4. Confirm Stripe has both a platform webhook and a Connect webhook pointing
   to `/api/stripe/webhook`, each with its own signing secret, receiving their
   respective events from the list in `STRIPE_MARKETPLACE.md`.
5. Confirm the production database is not reusing sandbox Stripe object IDs.
   Every live Creator must complete live-mode Connect onboarding, and live
   customers/checkouts must be created with the live key; Stripe test and live
   objects are separate.
6. Set `PAYMENTS_CHECKOUT_ENABLED=true` only for the controlled smoke, redeploy
   the exact reviewed candidate, and rerun the preflight. Every check must now
   pass. Run one low-value live transaction between a real business and a fully
   onboarded Express account. Verify Checkout, invoice, ledger, delayed payout,
   transfer, balance transaction, refund, and webhook delivery in both Stripe
   and SideSpace.
7. Confirm `GET /api/health/payments` returns `200` with the monitoring bearer
   secret and the payout cron returns `200` with `CRON_SECRET`.
8. Keep Checkout enabled only if the smoke and health checks pass; otherwise
   disable it and follow the rollback steps below.

## Alerts and ownership

Monitor `/api/health/payments` at least every five minutes. Alert immediately
on HTTP `503`, failed or stale webhooks, stuck or overdue payouts, stalled
refund resolutions, active disputes, post-payout refunds/disputes needing
recovery, or an unreachable Stripe API. Payments staff owns webhook replay,
refund/dispute response, and ledger-to-Stripe reconciliation, and
transfer-recovery failures. The on-call engineer owns application errors and
deployment rollback.

The hourly `/api/cron/release-payouts` job releases due payouts, safely retries
stuck idempotent transfer claims, retries failed transfer reversals, and
compares recent released transfers with the SideSpace ledger. Any mismatch
returns HTTP `500` so the scheduler/monitor can alert instead of silently
accepting drift.

## Rollback

1. Set `PAYMENTS_CHECKOUT_ENABLED=false` and redeploy. This immediately blocks
   creation of new Checkout Sessions.
2. Do **not** disable the webhook endpoint, rotate working webhook secrets, or
   roll back financial migrations. Existing payments still need refunds,
   disputes, webhook processing, and reconciliation.
3. Keep `PAYMENTS_LIVE_ENABLED` and the reviewed legal/tax/operations flags in
   place while live objects still exist; those gates allow lifecycle handling.
4. Inspect Stripe events, `/api/health/payments`, the payout cron result, and
   `payment_transactions` before deciding whether to replay a webhook, refund a
   charge, or retry a payout. Never edit money columns by hand.
5. Re-enable Checkout only after the fault is fixed, the exact replacement
   deployment is reviewed, health is green, and one low-value smoke test passes.

## Refunds and disputes

Use only the staff resolution route and Stripe-backed records. A refund against
a platform charge is reconciled separately from its Creator transfer. If a
`refund.created` event reports `pending`, keep the transaction in
`refund_pending`; do not treat the increased Stripe `amount_refunded` as a
terminal customer refund. The pre-release payout remains blocked until Stripe
sends a terminal `refund.updated` or `refund.failed`/canceled state. A pending
refund older than 15 minutes is surfaced by payment health monitoring.

If a succeeded refund or lost dispute happens after payout, the app queues an
idempotent cumulative transfer reversal and retries it from the hourly cron.
Stripe may reject the reversal when the connected account lacks available
balance; keep the health alert open and have payments staff resolve the balance
or reversal in Stripe before treating the recovery as complete.

## Evidence to retain

For every launch or incident, retain the deployment commit, migration list,
preflight output, webhook endpoint/event configuration, health result, Stripe
request/event IDs, transaction, transfer, and transfer-recovery IDs,
reconciliation output, and the named legal/tax approvers. Do not put secret
values in the record.
