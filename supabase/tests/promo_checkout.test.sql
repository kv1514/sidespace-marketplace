begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select extensions.no_plan();

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('50000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'promo-business@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('50000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'promo-creator@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, onboarding_complete
)
values
  ('50000000-0000-4000-8000-000000000011',
   '50000000-0000-4000-8000-000000000001',
   'business', 'Slack Test Business', true),
  ('50000000-0000-4000-8000-000000000012',
   '50000000-0000-4000-8000-000000000002',
   'creator', 'Slack Test Creator', true);

insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description
)
values (
  '50000000-0000-4000-8000-000000000021',
  '50000000-0000-4000-8000-000000000011',
  'Founder dashboard fixture', 'Physical', 'Placement', 25000,
  'Founder command account-summary fixture'
);


select is(public.grant_business_ad_credit_by_email('promo-business@example.invalid',2500,'Promo checkout test',repeat('e',64),'U123456')->>'balance_cents','2500','Slack grant reaches the shared credit ledger');
select public.create_business_referral_code('SS-PROMOTEST',1000,repeat('f',64),'U123456');
select set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select is((select awarded_cents from public.redeem_business_referral_credit('ss-promotest')),1000::bigint,'referral credit can be redeemed by its authenticated Business');
select is((select awarded_cents from public.redeem_business_referral_credit('ss-promotest')),0::bigint,'referral retries cannot mint more credits');
reset role;

-- Only bypass fixture provenance while creating synthetic campaigns.
alter table public.campaign_requests disable trigger campaign_requests_require_requestable_listing;
insert into public.campaign_requests (
 id,listing_id,requester_profile_id,owner_profile_id,campaign_name,goals,requested_deliverables,
 budget_cents,accepted_subtotal_cents,payer_profile_id,payee_profile_id,start_date,end_date,status
) select id,'50000000-0000-4000-8000-000000000021','50000000-0000-4000-8000-000000000011','50000000-0000-4000-8000-000000000012',
 'Promo campaign','Test credit funding','One placement',amount,amount,'50000000-0000-4000-8000-000000000011','50000000-0000-4000-8000-000000000012',current_date,current_date+7,'accepted'
from (values ('50000000-0000-4000-8000-000000000101'::uuid,10000),('50000000-0000-4000-8000-000000000102'::uuid,2000),('50000000-0000-4000-8000-000000000103'::uuid,1000)) x(id,amount);
alter table public.campaign_requests enable trigger campaign_requests_require_requestable_listing;
insert into public.payment_transactions (
 id,campaign_request_id,listing_id,business_profile_id,creator_profile_id,campaign_name,listing_title,business_name,creator_name,
 subtotal_cents,buyer_fee_cents,creator_fee_cents,customer_total_cents,creator_payout_cents,payout_amount_cents,platform_gross_revenue_cents,stripe_connected_account_id
) select id,campaign,'50000000-0000-4000-8000-000000000021','50000000-0000-4000-8000-000000000011','50000000-0000-4000-8000-000000000012',
 'Promo campaign','Promo listing','Business','Creator',amount,amount/20,amount/20,amount*105/100,amount*95/100,amount*95/100,amount/10,'acct_promo_test'
from (values ('50000000-0000-4000-8000-000000000201'::uuid,'50000000-0000-4000-8000-000000000101'::uuid,10000),('50000000-0000-4000-8000-000000000202'::uuid,'50000000-0000-4000-8000-000000000102'::uuid,2000),('50000000-0000-4000-8000-000000000203'::uuid,'50000000-0000-4000-8000-000000000103'::uuid,1000)) x(id,campaign,amount);

select is(public.reserve_business_ad_credit('50000000-0000-4000-8000-000000000011','50000000-0000-4000-8000-000000000201',10500)->>'reserved_cents','3500','both Slack and referral credits apply beyond the platform fee margin');
select is((select charged_total_cents from public.payment_transactions where id='50000000-0000-4000-8000-000000000201'),7000::bigint,'buyer pays the discounted charge');
select is((select payout_amount_cents from public.payment_transactions where id='50000000-0000-4000-8000-000000000201'),9500::bigint,'creator retains the entire agreed net payout');
select is((select payout_funding from public.payment_transactions where id='50000000-0000-4000-8000-000000000201'),'platform','SideSpace funds the shortfall');
select is(public.reserve_business_ad_credit('50000000-0000-4000-8000-000000000011','50000000-0000-4000-8000-000000000201',10500)->>'reserved_cents','3500','checkout retries reuse their reservation');
select is(public.reserve_business_ad_credit('50000000-0000-4000-8000-000000000011','50000000-0000-4000-8000-000000000202',2100)->>'reserved_cents','0','another checkout cannot spend credits already reserved');
select is(public.release_business_ad_credit('50000000-0000-4000-8000-000000000201'),3500::bigint,'expiry returns all unused reserved credit');
select is(public.release_business_ad_credit('50000000-0000-4000-8000-000000000201'),0::bigint,'expiry replay does not credit twice');
select throws_ok($$select public.reserve_business_ad_credit('50000000-0000-4000-8000-000000000011','50000000-0000-4000-8000-000000000201',10500)$$,'P0001','Start a new checkout attempt after releasing promo credit.','released reservations cannot be resurrected');
select is(public.reserve_business_ad_credit('50000000-0000-4000-8000-000000000011','50000000-0000-4000-8000-000000000202',2100)->>'reserved_cents','2100','credit can cover an entire checkout');
select is((select charged_total_cents from public.payment_transactions where id='50000000-0000-4000-8000-000000000202'),0::bigint,'fully credited order requires no cash charge');
select is((select sum(amount_cents) from public.business_ad_credit_ledger where business_profile_id='50000000-0000-4000-8000-000000000011'),1400::numeric,'unspent promo value stays available');
update public.payment_transactions set status='paid', paid_at=now(),stripe_checkout_session_id='cs_promo_free',workflow_status='paid_payout_pending',payout_status='pending' where id='50000000-0000-4000-8000-000000000202';
select lives_ok($$select public.mark_campaign_delivered('50000000-0000-4000-8000-000000000202','50000000-0000-4000-8000-000000000012')$$,'free order enters the normal delivery and review workflow');
select is(public.release_business_ad_credit('50000000-0000-4000-8000-000000000202'),0::bigint,'paid credits cannot be released by a late expiry');
select is(public.claim_campaign_payout_release('50000000-0000-4000-8000-000000000202','payer_confirmation','50000000-0000-4000-8000-000000000011')->'transaction'->>'payout_amount_cents','1900','verified free order releases the full normal Creator payout');
select is(public.record_platform_payout_funding_failure('50000000-0000-4000-8000-000000000202',0,'Platform balance temporarily insufficient'),true,'a definitive funding failure advances the retry key');
select is(public.record_platform_payout_funding_failure('50000000-0000-4000-8000-000000000202',0,'Duplicate failure'),false,'a duplicate failure cannot advance the retry key again');
select is((select payout_funding_attempt from public.payment_transactions where id='50000000-0000-4000-8000-000000000202'),1::bigint,'exactly one new funding attempt is recorded');
select is((select payout_status from public.payment_transactions where id='50000000-0000-4000-8000-000000000202'),'pending','funding failure remains retryable without losing Creator earnings');

-- Full promo refund before payout: restore credit atomically, with no cash refund.
update public.payment_transactions set workflow_status='issue_escalated',payout_status='blocked',issue_status='escalated' where id='50000000-0000-4000-8000-000000000202';
insert into public.staff_members(auth_user_id,role) values ('50000000-0000-4000-8000-000000000099','payments_admin');
insert into public.payment_issues(id,transaction_id,reported_by_profile_id,details,status,escalated_at) values ('50000000-0000-4000-8000-000000000301','50000000-0000-4000-8000-000000000202','50000000-0000-4000-8000-000000000011','Full promo refund fixture','escalated',now());
select throws_ok($$select public.claim_issue_refund_resolution('50000000-0000-4000-8000-000000000301','50000000-0000-4000-8000-000000000001','full_refund')$$,'P0001','Payments staff authorization is required.','non-staff cannot restore spent promo credits');
select is(public.claim_issue_refund_resolution('50000000-0000-4000-8000-000000000301','50000000-0000-4000-8000-000000000099','full_refund')->'resolution'->>'promo_refund_cents','2100','staff refund restores promo value without issuing cash');
select is(public.claim_issue_refund_resolution('50000000-0000-4000-8000-000000000301','50000000-0000-4000-8000-000000000099','full_refund')->>'duplicate','true','promo refund is idempotent');
select is((select sum(amount_cents) from public.business_ad_credit_ledger where business_profile_id='50000000-0000-4000-8000-000000000011'),3500::numeric,'refund restores exactly the spent promo credit');
select is((select payout_amount_cents from public.payment_transactions where id='50000000-0000-4000-8000-000000000202'),0::bigint,'refunded campaign cannot still pay out');
select is(public.get_business_ad_credit_balance('50000000-0000-4000-8000-000000000011')->>'balance_cents','3500','private balance reader matches the checkout ledger');
select ok(not has_function_privilege('authenticated','public.get_business_ad_credit_balance(uuid)','execute'),'members cannot query another profile balance via RPC');
select ok(not has_function_privilege('anon','public.get_business_ad_credit_balance(uuid)','execute'),'anonymous clients cannot inspect balances');
select * from extensions.finish();
rollback;
