# Balance and platform-funded promo credits

The dashboard Balance card opens a private account view with lifetime net campaign payouts sent to Stripe, campaign earnings still awaiting completion/review, Stripe available and pending funds, and a separate promotional credit balance. Referral and founder Slack grants share the same ledger. Business members can redeem a referral code from this view; the existing once-per-email guard remains in place.

Promo credit reduces the buyer's payment while preserving the creator's normal net payout. For a $100 campaign, the normal buyer total is $105 and the creator receives $95. A $50 promotion reduces the buyer's charge to $55; SideSpace still pays the creator $95. With $105 credit, Checkout is free and the creator still receives $95 after the normal delivery/review process.

When a charge cannot cover the creator payout, the transfer draws from SideSpace's **available Stripe platform balance**, without `source_transaction`. Fund this balance for the promotional liability; credit grants themselves do not add cash to Stripe. Insufficient-funds failures stay retryable. A definitive Stripe `balance_insufficient` rejection advances a database-guarded attempt key; ambiguous failures retain the original key to prevent duplicate transfers.

Fully credited orders are verified through completed Stripe Checkout sessions with matching zero amounts, currency, reserved promo metadata, and no PaymentIntent. Partial discounts leave either a zero total or Stripe's minimum $0.50 USD charge; any unused promo cents remain available. Free orders support an atomic staff full-credit refund before payout; partial cash refunds do not apply to a free order. Refunds on cash-plus-credit orders retain the existing proportional credit restoration and transfer recovery.

## Release requirements

Apply **only** `supabase/migrations/20260903010509_platform_funded_promo_credits.sql` to the intended database before deploying these routes. It replaces the old fee-margin cap, adds the generated payout funding source and retry counter, extends promo-only refunds, and adds the service-role-only atomic balance reader. Do not push unrelated pending migrations from this checkout.

The migration has been applied directly to the local database for testing. Direct SQL does not add a Supabase CLI migration-history row. Production migration and deployment have not been performed by this task. Existing credit grants and referral configuration in production must be preserved.

## Verification

Final checks: 229 application tests passed; 30 promo checkout, 45 delayed payout, and 23 transfer recovery database assertions passed. Local schema lint found no errors, and the production build passed. Disposable browser fixtures and the preview server were removed afterward.

- Application tests cover partial/full credit checkout parameters, free-order webhook verification, platform-funded release/recovery, ambiguous versus definitive funding failures, staff promo refunds, private balance authorization, currencies, and API row limits.
- `supabase/tests/promo_checkout.test.sql` exercises real local Slack grants, authenticated referral redemption, shared-ledger spending, replay protection, full creator payouts, expiry restoration, funding retries, promo-only refunds, and balance-reader permissions. It rolls back all fixtures.
- Stripe sandbox accepted a $105 checkout with $50 credit (subtotal $55) and with $105 credit (subtotal $0). Both sessions were immediately expired and the temporary customer removed; no charges were made.
- Browser verification used a disposable local Business/Creator profile: $25 founder credit plus a $10 referral became $35, shown separately from actual sandbox Stripe available/pending balances. Mobile layout at 390px had no horizontal overflow; Escape closed the dialog and returned focus to Balance.

These checks establish local and sandbox behavior. They are not evidence of a production real-money campaign payout.
