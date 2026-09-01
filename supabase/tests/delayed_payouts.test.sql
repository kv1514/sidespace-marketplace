begin;
create extension if not exists pgtap with schema extensions;
select plan(44);

insert into public.profiles (id, role, display_name, is_demo, onboarding_complete)
values
  ('10000000-0000-4000-8000-000000000001', 'business', 'Test Business', true, true),
  ('10000000-0000-4000-8000-000000000002', 'creator', 'Test Creator', true, true),
  ('10000000-0000-4000-8000-000000000003', 'business', 'Other Business', true, true);

insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description
) values (
  '10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000002',
  'Test campaign', 'Instagram', 'Post', 10000, 'Test listing'
);

-- This suite exercises payout state transitions, not request provenance. Its
-- profiles are demo fixtures, which the launch gate correctly keeps
-- non-requestable, so bypass only that trigger while seeding the fixture.
alter table public.campaign_requests
  disable trigger campaign_requests_require_requestable_listing;

insert into public.campaign_requests (
  id, listing_id, requester_profile_id, owner_profile_id, campaign_name,
  goals, requested_deliverables, budget_cents, accepted_subtotal_cents,
  payer_profile_id, payee_profile_id, start_date, end_date, status
)
select
  id,
  '10000000-0000-4000-8000-000000000010'::uuid,
  '10000000-0000-4000-8000-000000000001'::uuid,
  '10000000-0000-4000-8000-000000000002'::uuid,
  'Campaign ' || suffix,
  'Reach a local audience', 'One finished post', 10000, 10000,
  '10000000-0000-4000-8000-000000000001'::uuid,
  '10000000-0000-4000-8000-000000000002'::uuid,
  current_date, current_date + 7, 'accepted'
from (values
  ('10000000-0000-4000-8000-000000000101'::uuid, 'unpaid'),
  ('10000000-0000-4000-8000-000000000102'::uuid, 'confirm'),
  ('10000000-0000-4000-8000-000000000103'::uuid, 'issue'),
  ('10000000-0000-4000-8000-000000000104'::uuid, 'automatic'),
  ('10000000-0000-4000-8000-000000000105'::uuid, 'staff release'),
  ('10000000-0000-4000-8000-000000000106'::uuid, 'staff partial'),
  ('10000000-0000-4000-8000-000000000107'::uuid, 'staff full'),
  ('10000000-0000-4000-8000-000000000108'::uuid, 'issue at deadline')
) as campaigns(id, suffix);

alter table public.campaign_requests
  enable trigger campaign_requests_require_requestable_listing;

insert into public.payment_transactions (
  id, campaign_request_id, listing_id, business_profile_id,
  creator_profile_id, campaign_name, listing_title, business_name,
  creator_name, subtotal_cents, buyer_fee_cents, creator_fee_cents,
  customer_total_cents, creator_payout_cents, payout_amount_cents,
  platform_gross_revenue_cents, stripe_connected_account_id,
  stripe_charge_id, status, workflow_status, payout_status, paid_at
)
select
  transaction_id, campaign_id,
  '10000000-0000-4000-8000-000000000010'::uuid,
  '10000000-0000-4000-8000-000000000001'::uuid,
  '10000000-0000-4000-8000-000000000002'::uuid,
  'Campaign', 'Test campaign', 'Test Business', 'Test Creator',
  10000, 500, 500, 10500, 9500, 9500, 1000, 'acct_test_creator',
  charge_id,
  case when suffix = 'unpaid' then 'requires_checkout' else 'paid' end,
  case when suffix = 'unpaid' then 'requires_checkout' else 'paid_payout_pending' end,
  case when suffix = 'unpaid' then 'not_ready' else 'pending' end,
  case when suffix = 'unpaid' then null else now() end
from (values
  ('10000000-0000-4000-8000-000000000201'::uuid, '10000000-0000-4000-8000-000000000101'::uuid, 'ch_unpaid', 'unpaid'),
  ('10000000-0000-4000-8000-000000000202'::uuid, '10000000-0000-4000-8000-000000000102'::uuid, 'ch_confirm', 'confirm'),
  ('10000000-0000-4000-8000-000000000203'::uuid, '10000000-0000-4000-8000-000000000103'::uuid, 'ch_issue', 'issue'),
  ('10000000-0000-4000-8000-000000000204'::uuid, '10000000-0000-4000-8000-000000000104'::uuid, 'ch_auto', 'automatic'),
  ('10000000-0000-4000-8000-000000000205'::uuid, '10000000-0000-4000-8000-000000000105'::uuid, 'ch_staff_release', 'staff release'),
  ('10000000-0000-4000-8000-000000000206'::uuid, '10000000-0000-4000-8000-000000000106'::uuid, 'ch_staff_partial', 'staff partial'),
  ('10000000-0000-4000-8000-000000000207'::uuid, '10000000-0000-4000-8000-000000000107'::uuid, 'ch_staff_full', 'staff full'),
  ('10000000-0000-4000-8000-000000000208'::uuid, '10000000-0000-4000-8000-000000000108'::uuid, 'ch_boundary', 'issue at deadline')
) as transactions(transaction_id, campaign_id, charge_id, suffix);

select throws_ok(
  $$select public.mark_campaign_delivered(
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000002'
  )$$,
  'P0001', 'Payment must be verified before delivery.',
  'delivery requires a verified payment'
);

select throws_ok(
  $$select public.mark_campaign_delivered(
    '10000000-0000-4000-8000-000000000202',
    '10000000-0000-4000-8000-000000000003'
  )$$,
  'P0001', 'Only the Creator receiving this payout can mark delivery.',
  'only the payee can deliver'
);

select lives_ok(
  $$select public.mark_campaign_delivered(
    '10000000-0000-4000-8000-000000000202',
    '10000000-0000-4000-8000-000000000002'
  )$$,
  'the payee can mark a paid campaign delivered'
);

select is(
  (select review_deadline - delivered_at from public.payment_transactions
   where id = '10000000-0000-4000-8000-000000000202'),
  interval '72 hours',
  'review deadline is exactly 72 hours after delivery'
);

select throws_ok(
  $$select public.claim_campaign_payout_release(
    '10000000-0000-4000-8000-000000000202', 'automatic'
  )$$,
  'P0001', 'This payout is not due for automatic release.',
  'automatic release never runs before the deadline'
);

select throws_ok(
  $$select public.claim_campaign_payout_release(
    '10000000-0000-4000-8000-000000000202', 'payer_confirmation',
    '10000000-0000-4000-8000-000000000003'
  )$$,
  'P0001', 'Only the payer can confirm completion.',
  'only the payer can confirm completion'
);

select lives_ok(
  $$select public.claim_campaign_payout_release(
    '10000000-0000-4000-8000-000000000202', 'payer_confirmation',
    '10000000-0000-4000-8000-000000000001'
  )$$,
  'payer confirmation atomically claims release'
);

select lives_ok(
  $$select public.finalize_campaign_payout_release(
    '10000000-0000-4000-8000-000000000202', 'tr_confirm_once', 9500
  )$$,
  'the claimed payout finalizes once'
);

select is(
  (select payout_status from public.payment_transactions
   where id = '10000000-0000-4000-8000-000000000202'),
  'released',
  'finalization records a released payout'
);

select ok(
  (public.claim_campaign_payout_release(
    '10000000-0000-4000-8000-000000000202', 'payer_confirmation',
    '10000000-0000-4000-8000-000000000001'
  ) ->> 'already_released')::boolean,
  'duplicate confirmation is idempotent'
);

select throws_ok(
  $$select public.finalize_campaign_payout_release(
    '10000000-0000-4000-8000-000000000202', null, 9500
  )$$,
  'P0001', 'A Stripe transfer ID is required to finalize the payout.',
  'payout finalization rejects a missing transfer ID'
);

select throws_ok(
  $$select public.claim_campaign_payout_release(
    '10000000-0000-4000-8000-000000000202', 'payer_confirmation',
    '10000000-0000-4000-8000-000000000003'
  )$$,
  'P0001', 'Only the payer can confirm completion.',
  'idempotent completion still enforces payer authorization'
);

select lives_ok(
  $$select public.mark_campaign_delivered(
    '10000000-0000-4000-8000-000000000203',
    '10000000-0000-4000-8000-000000000002'
  )$$,
  'issue campaign can be delivered'
);

select throws_ok(
  $$select public.report_campaign_issue(
    '10000000-0000-4000-8000-000000000203',
    '10000000-0000-4000-8000-000000000003', 'The final post is missing.'
  )$$,
  'P0001', 'Only the payer can report an issue.',
  'only the payer can report an issue'
);

select lives_ok(
  $$select public.report_campaign_issue(
    '10000000-0000-4000-8000-000000000203',
    '10000000-0000-4000-8000-000000000001', 'The final post is missing.'
  )$$,
  'payer can report during the review window'
);

update public.payment_transactions
set delivered_at = now() - interval '73 hours',
    review_deadline = now() - interval '1 hour'
where id = '10000000-0000-4000-8000-000000000203';

select throws_ok(
  $$select public.claim_campaign_payout_release(
    '10000000-0000-4000-8000-000000000203', 'automatic'
  )$$,
  'P0001', 'This payout is not due for automatic release.',
  'an issue prevents automatic release'
);

select is(
  (select payout_status from public.payment_transactions
   where id = '10000000-0000-4000-8000-000000000203'),
  'blocked',
  'reported issue keeps payout blocked'
);

select lives_ok(
  $$select public.mark_campaign_delivered(
    '10000000-0000-4000-8000-000000000204',
    '10000000-0000-4000-8000-000000000002'
  )$$,
  'automatic-release campaign can be delivered'
);

update public.payment_transactions
set delivered_at = now() - interval '72 hours',
    review_deadline = now()
where id = '10000000-0000-4000-8000-000000000204';

select lives_ok(
  $$select public.claim_campaign_payout_release(
    '10000000-0000-4000-8000-000000000204', 'automatic'
  )$$,
  'automatic release is allowed at the deadline'
);

select is(
  (select payout_status from public.payment_transactions
   where id = '10000000-0000-4000-8000-000000000204'),
  'releasing',
  'automatic claim is atomic and retryable'
);

select lives_ok(
  $$select public.record_campaign_payout_release_failure(
    '10000000-0000-4000-8000-000000000204', 'temporary Stripe failure'
  )$$,
  'a failed transfer claim returns to a retryable pending state'
);

select is(
  (select payout_status from public.payment_transactions
   where id = '10000000-0000-4000-8000-000000000204'),
  'pending',
  'failed transfer claims do not strand the payout'
);

select lives_ok(
  $$select public.claim_campaign_payout_release(
    '10000000-0000-4000-8000-000000000204', 'automatic'
  )$$,
  'a failed transfer claim can be retried after reset'
);

select lives_ok(
  $$select public.mark_campaign_delivered(
    '10000000-0000-4000-8000-000000000208',
    '10000000-0000-4000-8000-000000000002'
  )$$,
  'a boundary campaign can be delivered'
);

update public.payment_transactions
set delivered_at = now() - interval '72 hours',
    review_deadline = now()
where id = '10000000-0000-4000-8000-000000000208';

select throws_ok(
  $$select public.report_campaign_issue(
    '10000000-0000-4000-8000-000000000208',
    '10000000-0000-4000-8000-000000000001', 'Issue reported at the deadline.'
  )$$,
  'P0001', 'The review period has ended or this campaign is already complete.',
  'issue reporting closes at the exact 72-hour deadline'
);

insert into public.staff_members (auth_user_id, role)
values ('20000000-0000-4000-8000-000000000001', 'payments_admin');

update public.payment_transactions
set workflow_status = 'issue_escalated', payout_status = 'blocked',
    issue_status = 'escalated', issue_reported_at = now(), escalated_at = now()
where id in (
  '10000000-0000-4000-8000-000000000205',
  '10000000-0000-4000-8000-000000000206',
  '10000000-0000-4000-8000-000000000207'
);

insert into public.payment_issues (
  id, transaction_id, reported_by_profile_id, details, status, escalated_at
) values
  ('30000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000205', '10000000-0000-4000-8000-000000000001', 'Release after staff review.', 'escalated', now()),
  ('30000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000206', '10000000-0000-4000-8000-000000000001', 'Return part of the campaign amount.', 'escalated', now()),
  ('30000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000207', '10000000-0000-4000-8000-000000000001', 'Return the full campaign amount.', 'escalated', now());

select throws_ok(
  $$select public.claim_campaign_payout_release(
    '10000000-0000-4000-8000-000000000205', 'staff', null,
    '20000000-0000-4000-8000-000000000099'
  )$$,
  'P0001', 'Payments staff authorization is required.',
  'unauthorized users cannot release an escalated payout'
);

select throws_ok(
  $$select public.claim_issue_refund_resolution(
    '30000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000001',
    'partial_refund', 10499, 'Leave no sub-cent Creator payout'
  )$$,
  'P0001', 'The remaining Creator payout is below one cent; use a full refund.',
  'near-total partial refunds cannot force a one-cent overpayment'
);

select lives_ok(
  $$select public.claim_campaign_payout_release(
    '10000000-0000-4000-8000-000000000205', 'staff', null,
    '20000000-0000-4000-8000-000000000001'
  )$$,
  'authorized payments staff can release an escalated payout'
);

select lives_ok(
  $$select public.record_campaign_payout_release_failure(
    '10000000-0000-4000-8000-000000000205', 'temporary Stripe failure'
  )$$,
  'a failed staff release returns the issue to an escalated retryable state'
);

select is(
  (select issue_status from public.payment_transactions
   where id = '10000000-0000-4000-8000-000000000205'),
  'escalated',
  'failed staff releases restore escalated issue authorization'
);

select lives_ok(
  $$select public.claim_campaign_payout_release(
    '10000000-0000-4000-8000-000000000205', 'staff', null,
    '20000000-0000-4000-8000-000000000001'
  )$$,
  'a failed staff release can be retried'
);

select lives_ok(
  $$select public.finalize_campaign_payout_release(
    '10000000-0000-4000-8000-000000000205', 'tr_staff_once', 9500
  )$$,
  'the retried staff release finalizes'
);

select throws_ok(
  $$select public.claim_issue_refund_resolution(
    '30000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000099',
    'partial_refund', 1000, 'Not authorized'
  )$$,
  'P0001', 'Payments staff authorization is required.',
  'unauthorized users cannot issue staff refunds'
);

select lives_ok(
  $$select public.claim_issue_refund_resolution(
    '30000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000001',
    'partial_refund', 1000, 'Partial delivery accepted'
  )$$,
  'staff can claim a partial refund resolution'
);

select is(
  (select action from public.payment_resolution_actions
   where issue_id = '30000000-0000-4000-8000-000000000006'),
  'partial_refund',
  'partial refund resolution is recorded explicitly'
);

update public.payment_resolution_actions
set status = 'completed'
where issue_id = '30000000-0000-4000-8000-000000000006';

-- Simulate the succeeded refund webhook before the remaining payout release.
update public.payment_transactions
set status = 'partially_refunded', workflow_status = 'partially_refunded'
where id = '10000000-0000-4000-8000-000000000206';

select lives_ok(
  $$select public.claim_campaign_payout_release(
    '10000000-0000-4000-8000-000000000206', 'partial_refund_resolution'
  )$$,
  'a completed partial refund claims the remaining payout'
);

select is(
  (select payout_amount_cents from public.payment_transactions
   where id = '10000000-0000-4000-8000-000000000206'),
  8595::bigint,
  'partial refund adjusts the payout with integer-cent pro-rata math'
);

select lives_ok(
  $$select public.record_campaign_payout_release_failure(
    '10000000-0000-4000-8000-000000000206', 'temporary Stripe failure'
  )$$,
  'a failed partial-refund payout is returned to a retryable blocked state'
);

select is(
  (select payout_status from public.payment_transactions
   where id = '10000000-0000-4000-8000-000000000206'),
  'blocked',
  'partial-refund payout failures stay blocked until retry'
);

select lives_ok(
  $$select public.claim_campaign_payout_release(
    '10000000-0000-4000-8000-000000000206', 'partial_refund_resolution'
  )$$,
  'a failed partial-refund payout can be retried by the recovery path'
);

select lives_ok(
  $$select public.finalize_campaign_payout_release(
    '10000000-0000-4000-8000-000000000206', 'tr_partial_once', 8595
  )$$,
  'the adjusted partial-refund payout finalizes'
);

select is(
  (select payout_status from public.payment_transactions
   where id = '10000000-0000-4000-8000-000000000206'),
  'released',
  'partial-refund payout is recorded as released only after finalization'
);

select lives_ok(
  $$select public.claim_issue_refund_resolution(
    '30000000-0000-4000-8000-000000000007',
    '20000000-0000-4000-8000-000000000001',
    'full_refund', null, 'Campaign could not be completed'
  )$$,
  'staff can claim a full refund resolution'
);

select is(
  (select refund_amount_cents from public.payment_resolution_actions
   where issue_id = '30000000-0000-4000-8000-000000000007'),
  10500::bigint,
  'full refund uses the entire remaining trusted customer charge'
);

select * from finish();
rollback;
