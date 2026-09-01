begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

insert into public.profiles (id, role, display_name, is_demo, onboarding_complete)
values
  ('40000000-0000-4000-8000-000000000001', 'business', 'Recovery Buyer', true, true),
  ('40000000-0000-4000-8000-000000000002', 'creator', 'Recovery Creator', true, true);

insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description
) values (
  '40000000-0000-4000-8000-000000000010',
  '40000000-0000-4000-8000-000000000002',
  'Recovery listing', 'Instagram', 'Post', 10000, 'Transfer recovery fixture'
);

alter table public.campaign_requests
  disable trigger campaign_requests_require_requestable_listing;

insert into public.campaign_requests (
  id, listing_id, requester_profile_id, owner_profile_id, campaign_name,
  goals, requested_deliverables, budget_cents, accepted_subtotal_cents,
  payer_profile_id, payee_profile_id, start_date, end_date, status
) values (
  '40000000-0000-4000-8000-000000000101',
  '40000000-0000-4000-8000-000000000010',
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000002',
  'Recovery campaign', 'Test transfer recovery', 'One post', 10000, 10000,
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000002',
  current_date, current_date + 7, 'refunded'
);

alter table public.campaign_requests
  enable trigger campaign_requests_require_requestable_listing;

insert into public.payment_transactions (
  id, campaign_request_id, listing_id, business_profile_id,
  creator_profile_id, campaign_name, listing_title, business_name,
  creator_name, subtotal_cents, buyer_fee_cents, creator_fee_cents,
  customer_total_cents, creator_payout_cents, payout_amount_cents,
  platform_gross_revenue_cents, stripe_connected_account_id,
  stripe_charge_id, stripe_transfer_id, status, workflow_status, payout_status,
  payout_released_at, paid_at
) values (
  '40000000-0000-4000-8000-000000000201',
  '40000000-0000-4000-8000-000000000101',
  '40000000-0000-4000-8000-000000000010',
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000002',
  'Recovery campaign', 'Recovery listing', 'Recovery Buyer', 'Recovery Creator',
  10000, 500, 500, 10500, 9500, 9500, 1000, 'acct_recovery_creator',
  'ch_recovery', 'tr_recovery', 'refunded', 'refunded', 'released', now(), now()
);

select is(
  (select payout_recovery_status from public.payment_transactions
   where id = '40000000-0000-4000-8000-000000000201'),
  'not_required',
  'released legacy state starts without a recovery claim'
);

create temporary table pgtap_recovery_claim as
select public.queue_campaign_transfer_reversal(
    '40000000-0000-4000-8000-000000000201', 905, 'refund'
  ) as payload;

select is(
  ((select payload from pgtap_recovery_claim) ->> 'should_process')::boolean,
  true,
  'a refund queues and claims the required transfer recovery'
);

select is(
  (select payload ->> 'stripe_charge_id' from pgtap_recovery_claim),
  'ch_recovery',
  'recovery claims are bound to the original platform charge'
);

select is(
  (select status from public.payment_transfer_reversals
   where transaction_id = '40000000-0000-4000-8000-000000000201'
     and target_amount_cents = 905),
  'processing',
  'the recovery claim is durable and processing'
);

select is(
  (select idempotency_key from public.payment_transfer_reversals
   where transaction_id = '40000000-0000-4000-8000-000000000201'
     and target_amount_cents = 905),
  'sidespace-payout-reversal-40000000-0000-4000-8000-000000000201-905',
  'recovery attempts use a stable target-scoped idempotency key'
);

select is(
  (select payout_recovery_status from public.payment_transactions
   where id = '40000000-0000-4000-8000-000000000201'),
  'processing',
  'the transaction exposes active recovery state'
);

select lives_ok(
  $$select public.finalize_campaign_transfer_reversal(
    (select id from public.payment_transfer_reversals
     where transaction_id = '40000000-0000-4000-8000-000000000201'
       and target_amount_cents = 905),
    'trr_recovery_1', 905
  )$$,
  'a verified Stripe reversal finalizes the recovery'
);

select is(
  (select payout_recovery_status from public.payment_transactions
   where id = '40000000-0000-4000-8000-000000000201'),
  'recovered',
  'the ledger records a recovered payout'
);

select is(
  (select payout_recovery_reversed_cents from public.payment_transactions
   where id = '40000000-0000-4000-8000-000000000201'),
  905::bigint,
  'the ledger records the exact reversed cents'
);

select is(
  (select status from public.payment_transfer_reversals
   where transaction_id = '40000000-0000-4000-8000-000000000201'
     and target_amount_cents = 905),
  'succeeded',
  'the recovery record is succeeded'
);

select is(
  (public.queue_campaign_transfer_reversal(
    '40000000-0000-4000-8000-000000000201', 905, 'refund'
  ) ->> 'should_process')::boolean,
  false,
  'repeating the same target is idempotent'
);

select is(
  (public.finalize_campaign_transfer_reversal(
    (select id from public.payment_transfer_reversals
     where transaction_id = '40000000-0000-4000-8000-000000000201'
       and target_amount_cents = 905),
    'trr_recovery_1', 905
  ) ->> 'already_finalized')::boolean,
  true,
  'repeating finalization does not append a second financial transition'
);

select is(
  (public.queue_campaign_transfer_reversal(
    '40000000-0000-4000-8000-000000000201', 9500, 'dispute'
  ) ->> 'should_process')::boolean,
  true,
  'a larger cumulative target creates a new recovery attempt'
);

select is(
  (select count(*)::integer from public.payment_transfer_reversals
   where transaction_id = '40000000-0000-4000-8000-000000000201'),
  2,
  'recovery history keeps separate cumulative targets'
);

select is(
  (select status from public.payment_transfer_reversals
   where transaction_id = '40000000-0000-4000-8000-000000000201'
     and target_amount_cents = 9500),
  'processing',
  'the newest cumulative target is claimed'
);

select lives_ok(
  $$select public.record_campaign_transfer_reversal_failure(
    (select id from public.payment_transfer_reversals
     where transaction_id = '40000000-0000-4000-8000-000000000201'
       and target_amount_cents = 9500),
    'connected account balance is unavailable'
  )$$,
  'a Stripe recovery failure is recorded for retry'
);

select is(
  (select status from public.payment_transfer_reversals
   where transaction_id = '40000000-0000-4000-8000-000000000201'
     and target_amount_cents = 9500),
  'failed',
  'failed recovery remains retryable'
);

select is(
  (select payout_recovery_status from public.payment_transactions
   where id = '40000000-0000-4000-8000-000000000201'),
  'failed',
  'failed recovery is visible to payment health monitoring'
);

select is(
  (public.queue_campaign_transfer_reversal(
    '40000000-0000-4000-8000-000000000201', 0, 'refund'
  ) ->> 'status'),
  'failed',
  'a zero target cannot hide an existing unrecovered target'
);

select ok(
  (select next_attempt_at > now() from public.payment_transfer_reversals
   where transaction_id = '40000000-0000-4000-8000-000000000201'
     and target_amount_cents = 9500),
  'failed recovery receives a future retry time'
);

update public.payment_transfer_reversals
set status = 'processing', claimed_at = now() - interval '16 minutes'
where transaction_id = '40000000-0000-4000-8000-000000000201'
  and target_amount_cents = 9500;

select is(
  (public.queue_campaign_transfer_reversal(
    '40000000-0000-4000-8000-000000000201', 9500, 'dispute'
  ) ->> 'should_process')::boolean,
  true,
  'a stale worker claim can be safely reclaimed'
);

select throws_ok(
  $$select public.queue_campaign_transfer_reversal(
    '40000000-0000-4000-8000-000000000201', 9501, 'refund'
  )$$,
  'P0001', 'The transfer reversal exceeds the released payout.',
  'recovery cannot exceed the released Creator transfer'
);

update public.payment_transactions
set stripe_transfer_id = null
where id = '40000000-0000-4000-8000-000000000201';

select throws_ok(
  $$select public.finalize_campaign_transfer_reversal(
    (select id from public.payment_transfer_reversals
     where transaction_id = '40000000-0000-4000-8000-000000000201'
       and target_amount_cents = 9500),
    'trr_creator', 9500
  )$$,
  'P0001', 'The Stripe transfer does not match the payment ledger.',
  'recovery finalization rejects a transaction missing its transfer identity'
);

select * from finish();
rollback;
