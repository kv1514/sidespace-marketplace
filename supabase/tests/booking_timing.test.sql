begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();
select set_config('request.jwt.claims','{"role":"service_role"}',true);

insert into auth.users (id, aud, role, email, created_at, updated_at) values
 ('81000000-0000-4000-8000-000000000001','authenticated','authenticated','calendar-owner@example.invalid',now(),now()),
 ('81000000-0000-4000-8000-000000000002','authenticated','authenticated','calendar-buyer@example.invalid',now(),now()),
 ('81000000-0000-4000-8000-000000000003','authenticated','authenticated','calendar-other@example.invalid',now(),now());
insert into public.profiles (id,auth_user_id,role,display_name,onboarding_complete) values
 ('82000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001','creator','Calendar Owner',true),
 ('82000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000002','business','Calendar Buyer',true),
 ('82000000-0000-4000-8000-000000000003','81000000-0000-4000-8000-000000000003','business','Calendar Other',true);
insert into public.listings (id,owner_profile_id,title,channel,format,price_cents,deliverables,cancellation_policy,
  provenance_status,availability_confirmed_at,instant_booking_enabled,availability_dates,booking_duration_days,lead_time_days)
values ('83000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001','Calendar package','Instagram','One reel',10000,
 'One reel and a report','Free cancellation up to 48 hours before.', 'owner_attested',now(),true,
 array[current_date+3,current_date+4,current_date+5,current_date+8,current_date+9],2,2);
insert into public.stripe_accounts(profile_id,livemode,stripe_connected_account_id,charges_enabled,payouts_enabled,details_submitted,requirements_due)
values ('82000000-0000-4000-8000-000000000001',false,'acct_calendar_fixture',true,true,true,'{}');

select set_config('request.jwt.claims','{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select lives_ok($$insert into public.profile_contacts(profile_id,contact_email) values('82000000-0000-4000-8000-000000000001','private@example.invalid') on conflict(profile_id) do update set contact_email=excluded.contact_email$$,'First-time setup can save private contact details');
select throws_like($$insert into public.profile_contacts(profile_id,contact_email) values('82000000-0000-4000-8000-000000000002','forged@example.invalid')$$,'%row-level security%','Cannot write another profile contact');
reset role;
select set_config('request.jwt.claims','{"sub":"81000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*) from public.profile_contacts where profile_id='82000000-0000-4000-8000-000000000001'),0::bigint,'Another member cannot read the private contact');
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);

update public.listings set timing_kind='date_range',pricing_kind='week',price_cents=7000,booking_duration_days=1,
 availability_dates=array(select current_date+n from generate_series(3,60) n)
 where id='83000000-0000-4000-8000-000000000001';
create function pg_temp.quote(first_day integer,last_day integer) returns jsonb language sql as $$
 select public.quote_listing_booking('83000000-0000-4000-8000-000000000001',current_date+first_day,current_date+last_day,
 (select updated_at from public.listings where id='83000000-0000-4000-8000-000000000001'))
$$;
create function pg_temp.reserve(first_day integer,last_day integer,buyer uuid default '82000000-0000-4000-8000-000000000002') returns uuid language sql as $$
 select public.reserve_listing_booking('83000000-0000-4000-8000-000000000001',buyer,current_date+first_day,
 (select updated_at from public.listings where id='83000000-0000-4000-8000-000000000001'),false,current_date+last_day)
$$;
select ok(not has_function_privilege('authenticated','public.quote_listing_booking(uuid,date,date,timestamptz)','execute'),'Quote uses the server boundary');
select ok(not has_function_privilege('authenticated','public.reserve_listing_booking(uuid,uuid,date,timestamptz,boolean,date)','execute'),'New reservation overload is server only');
set local role service_role;
select is((pg_temp.quote(3,12)->>'subtotalCents')::bigint,10000::bigint,'Ten days at 70 per week cost 100');
select is((pg_temp.quote(3,3)->>'days')::integer,1,'Single-day ranges are inclusive');
select is((select count(*) from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001'),0::bigint,'Quoting does not create a campaign');
select is((select count(*) from private.listing_booking_reservations where listing_id='83000000-0000-4000-8000-000000000001'),0::bigint,'Quoting does not hold dates');
select throws_like($$select pg_temp.quote(1,8)$$,'%notice%','Quote respects lead time');
select throws_like($$select pg_temp.quote(3,366)$$,'%next year%','Quote checks the full horizon');
select throws_like($$select public.quote_listing_booking('83000000-0000-4000-8000-000000000001',current_date+3,current_date+12,now()-interval '1 day')$$,'%listing changed%','Stale version cannot quote');
reset role;
update public.listings set availability_dates=array_remove(availability_dates,current_date+7) where id='83000000-0000-4000-8000-000000000001';
select throws_like($$select pg_temp.quote(3,12)$$,'%not available%','An unavailable intermediate day rejects the range');
update public.listings set availability_dates=array_append(availability_dates,current_date+7),minimum_duration_days=5 where id='83000000-0000-4000-8000-000000000001';
select throws_like($$select pg_temp.quote(3,4)$$,'%at least 5%','Seller minimum duration is enforced');
set local role service_role;
select lives_ok($$select pg_temp.reserve(3,12)$$,'Variable range can reserve');
select is((select accepted_subtotal_cents from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001'),10000::bigint,'Accepted subtotal is the server quote');
select is((select timing_kind from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001'),'date_range','Timing is snapshotted');
select lives_ok($$select pg_temp.reserve(3,12)$$,'Exact interval retries reuse the hold');
select throws_like($$select pg_temp.reserve(3,13)$$,'%just booked%','Same start with a different end cannot reuse a cheaper hold');
select throws_like($$select pg_temp.reserve(6,14,'82000000-0000-4000-8000-000000000003')$$,'%just booked%','Overlapping ranges cannot both reserve');
select throws_like($$update public.campaign_requests set timing_kind='deadline' where listing_id='83000000-0000-4000-8000-000000000001'$$,'%immutable%','Snapshot timing cannot change');
select throws_like($$update public.campaign_requests set listing_terms='{}' where listing_id='83000000-0000-4000-8000-000000000001'$$,'%immutable%','Snapshot terms cannot change');
reset role;
update public.listings set timing_kind='deadline',pricing_kind='fixed',minimum_duration_days=1,price_cents=9000 where id='83000000-0000-4000-8000-000000000001';
select is((pg_temp.quote(20,20)->>'subtotalCents')::bigint,9000::bigint,'One-time work has a fixed total');
select throws_like($$select pg_temp.quote(20,21)$$,'%one delivery deadline%','Deadline cannot become a date range');
set local role service_role;
select lives_ok($$select pg_temp.reserve(20,20)$$,'Delivery deadline can reserve');
select throws_like($$select pg_temp.reserve(20,21)$$,'%one delivery deadline%','Deadline retries must match the complete interval');
select is((select end_date-start_date from public.campaign_requests where timing_kind='deadline' and listing_id='83000000-0000-4000-8000-000000000001'),0,'Deadline stores no artificial work interval');
select is((select accepted_subtotal_cents from public.campaign_requests where timing_kind='date_range' and listing_id='83000000-0000-4000-8000-000000000001'),10000::bigint,'Editing a listing does not reprice existing bookings');
reset role;
-- Seller-approved fixed-term requests still use RLS and server-checked pricing.
update public.listings set instant_booking_enabled=false where id='83000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims','{"sub":"81000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select throws_like($$insert into public.campaign_requests(listing_id,requester_profile_id,owner_profile_id,campaign_name,goals,requested_deliverables,budget_cents,start_date,end_date,purchase_mode,listing_terms)
values('83000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002','82000000-0000-4000-8000-000000000001','Forged price','','One reel and a report',1,current_date+30,current_date+30,'buy_now',jsonb_build_object('listing_updated_at',now()))$$,'%price changed%','Browser cannot forge a book-as-listed price');
select lives_ok($$insert into public.campaign_requests(listing_id,requester_profile_id,owner_profile_id,campaign_name,goals,requested_deliverables,budget_cents,start_date,end_date,purchase_mode,listing_terms)
values('83000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002','82000000-0000-4000-8000-000000000001','Delivery request','','One reel and a report',9000,current_date+30,current_date+30,'buy_now',jsonb_build_object('listing_updated_at',now()))$$,'Correct quote can create a pending request with optional goals');
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update public.listings set price_cents=18000 where id='83000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims','{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select lives_ok($$select public.respond_campaign_request((select id from public.campaign_requests where campaign_name='Delivery request'),'accepted')$$,'Owner accepts previously quoted terms after editing the listing');
select is((select accepted_subtotal_cents from public.campaign_requests where campaign_name='Delivery request'),9000::bigint,'Acceptance retains the requested price');
reset role;
select is(private.listing_subtotal_cents(100,10,'week'),143::bigint,'Fractional weekly cents round once');
select is(private.listing_subtotal_cents(101,15,'30_days'),51::bigint,'Half cents round up on the final subtotal');
select * from finish();
rollback;
