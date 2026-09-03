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
create function pg_temp.book(day_offset integer, buyer uuid default '82000000-0000-4000-8000-000000000002') returns uuid
language sql security invoker as $$
 select public.reserve_listing_booking('83000000-0000-4000-8000-000000000001',buyer,current_date+day_offset,
 (select updated_at from public.listings where id='83000000-0000-4000-8000-000000000001'),false)
$$;

select ok(not has_function_privilege('anon','public.reserve_listing_booking(uuid,uuid,date,timestamptz,boolean)','execute'),'Anonymous buyers cannot reserve directly');
select ok(not has_function_privilege('authenticated','public.reserve_listing_booking(uuid,uuid,date,timestamptz,boolean)','execute'),'Authenticated clients cannot forge paid parties or amounts');
select ok(not has_function_privilege('authenticated','public.begin_listing_booking_checkout(uuid)','execute'),'Only the checkout server can pin inventory');
select ok(not has_table_privilege('authenticated','private.listing_booking_reservations','select'),'Reservation terms and buyer activity stay private');
select ok(has_column_privilege('anon','public.listings','availability_dates','select'),'Public listing projection includes published availability');
select is(public.listing_available_dates('83000000-0000-4000-8000-000000000001'),array[current_date+3,current_date+4,current_date+8],'Only complete consecutive packages are selectable');
select throws_like($$update public.listings set availability_dates=array[current_date+366] where id='83000000-0000-4000-8000-000000000001'$$,'%next year%','Database enforces the one-year horizon');
select throws_like($$update public.listings set cancellation_policy='' where id='83000000-0000-4000-8000-000000000001'$$,'%cancellation terms%','Cancellation terms are required');
select throws_like($$update public.listings set price_max_cents=20000 where id='83000000-0000-4000-8000-000000000001'$$,'%fixed price%','Price ranges cannot be instant booked');
select throws_like($$update public.listings set booking_timezone='Invalid/Zone' where id='83000000-0000-4000-8000-000000000001'$$,'%time zone%','Invalid zones cannot bypass date validation');

set local role service_role;
select throws_like($$select pg_temp.book(1)$$,'%required notice%','Lead time is enforced by the database');
select throws_like($$select pg_temp.book(5)$$,'%not available%','A partially available package cannot be purchased');
select throws_like($$select pg_temp.book(3,'82000000-0000-4000-8000-000000000001')$$,'%Business profile%','Owner cannot buy own inventory');
select lives_ok($$select pg_temp.book(3)$$,'Seller pre-authorization creates an accepted booking directly');
select is((select status from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001'),'accepted','No owner acceptance step');
select is((select accepted_subtotal_cents from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001'),10000::bigint,'Accepted price comes from the listing');
select is((select requested_deliverables from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001'),'One reel and a report','Deliverables are copied from the seller');
select is((select count(*) from public.notifications where recipient_profile_id='82000000-0000-4000-8000-000000000001'),0::bigint,'Unpaid instant holds do not send acceptance-request notifications');
select is((select purchase_mode from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001'),'buy_now','Fixed-term immutability remains active');
select lives_ok($$select pg_temp.book(3)$$,'Retry returns the existing unpaid booking');
select is((select count(*) from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001'),1::bigint,'Retry does not create duplicate campaigns');
select throws_like($$select pg_temp.book(3,'82000000-0000-4000-8000-000000000003')$$,'%just booked%','Second buyer cannot reserve the same package');
select throws_like($$select pg_temp.book(4,'82000000-0000-4000-8000-000000000003')$$,'%just booked%','Overlapping multi-day packages cannot be sold');
select is(public.listing_available_dates('83000000-0000-4000-8000-000000000001'),array[current_date+8],'Public calendar hides reserved and overlapping starts');
select throws_like($$update public.campaign_requests set requested_deliverables='Altered terms' where listing_id='83000000-0000-4000-8000-000000000001'$$,'%immutable%','Booking deliverables cannot be rewritten after reservation');
select throws_like($$insert into public.campaign_requests(listing_id,requester_profile_id,owner_profile_id,campaign_name,goals,requested_deliverables,budget_cents,start_date,end_date,status) values('83000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000003','82000000-0000-4000-8000-000000000001','Custom campaign','Test a conflicting offer','One reel',10000,current_date+4,current_date+5,'accepted')$$,'%already reserved%','Custom offers cannot accept dates held by checkout');
update private.listing_booking_reservations set held_until=now()-interval '1 minute' where listing_id='83000000-0000-4000-8000-000000000001';
select is(public.listing_available_dates('83000000-0000-4000-8000-000000000001'),array[current_date+3,current_date+4,current_date+8],'Expired unstarted holds become available');
select throws_like($$select public.begin_listing_booking_checkout(id) from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001'$$,'%hold expired%','A stale campaign ID cannot start checkout');
select lives_ok($$select pg_temp.book(3,'82000000-0000-4000-8000-000000000003')$$,'Another buyer can acquire an expired unstarted hold');
select lives_ok($$select public.begin_listing_booking_checkout(id) from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001' and status='accepted'$$,'Checkout atomically pins the reservation');
select ok((select checkout_expires_at between now()+interval '44 minutes' and now()+interval '46 minutes' from private.listing_booking_reservations where released_at is null and listing_id='83000000-0000-4000-8000-000000000001'),'Checkout receives a persisted expiry for stable Stripe retries');
update private.listing_booking_reservations set held_until=now()-interval '1 hour' where released_at is null and listing_id='83000000-0000-4000-8000-000000000001';
select is(public.listing_available_dates('83000000-0000-4000-8000-000000000001'),array[current_date+8],'Started checkout stays held even after the local timer');
select throws_like($$select pg_temp.book(3)$$,'%just booked%','Uncertain Stripe results cannot free inventory to a second buyer');
-- Provider-verified expiration frees inventory, while paid bookings stay blocked.
insert into public.payment_transactions (
 id,campaign_request_id,listing_id,business_profile_id,creator_profile_id,campaign_name,listing_title,business_name,creator_name,
 subtotal_cents,buyer_fee_cents,creator_fee_cents,customer_total_cents,creator_payout_cents,payout_amount_cents,platform_gross_revenue_cents,
 stripe_connected_account_id,status
) select '84000000-0000-4000-8000-000000000001',c.id,c.listing_id,c.requester_profile_id,c.owner_profile_id,
 c.campaign_name,'Calendar package','Calendar Other','Calendar Owner',10000,500,500,10500,9500,9500,1000,'acct_calendar_fixture','checkout_open'
 from public.campaign_requests c where c.listing_id='83000000-0000-4000-8000-000000000001' and c.status='accepted';
update public.payment_transactions set status='expired' where id='84000000-0000-4000-8000-000000000001';
select is(public.listing_available_dates('83000000-0000-4000-8000-000000000001'),array[current_date+3,current_date+4,current_date+8],'Provider expiry frees the dates');
select is((select count(*) from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001' and status='accepted'),0::bigint,'Expired instant campaigns cannot restart checkout by ID');
select lives_ok($$select pg_temp.book(3)$$,'A new booking is possible after provider expiry');
select public.begin_listing_booking_checkout(id) from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001' and status='accepted';
insert into public.payment_transactions (
 id,campaign_request_id,listing_id,business_profile_id,creator_profile_id,campaign_name,listing_title,business_name,creator_name,
 subtotal_cents,buyer_fee_cents,creator_fee_cents,customer_total_cents,creator_payout_cents,payout_amount_cents,platform_gross_revenue_cents,
 stripe_connected_account_id,status
) select '84000000-0000-4000-8000-000000000002',c.id,c.listing_id,c.requester_profile_id,c.owner_profile_id,
 c.campaign_name,'Calendar package','Calendar Buyer','Calendar Owner',10000,500,500,10500,9500,9500,1000,'acct_calendar_fixture','paid'
 from public.campaign_requests c where c.listing_id='83000000-0000-4000-8000-000000000001' and c.status='accepted';
update public.campaign_requests set status='confirmed' where listing_id='83000000-0000-4000-8000-000000000001' and status='accepted';
select is((select count(*) from public.notifications where context_id in (select id from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001') and subject like '%booking%'),2::bigint,'Payment confirmation queues a booking notice for both parties');
update public.campaign_requests set status='confirmed' where listing_id='83000000-0000-4000-8000-000000000001' and status='confirmed';
select is((select count(*) from public.notifications where context_id in (select id from public.campaign_requests where listing_id='83000000-0000-4000-8000-000000000001') and subject like '%booking%'),2::bigint,'Repeated payment confirmation does not duplicate notifications');
update public.payment_transactions set status='expired' where id='84000000-0000-4000-8000-000000000002';
select is(public.listing_available_dates('83000000-0000-4000-8000-000000000001'),array[current_date+8],'A stale expiry cannot release already-paid inventory');
update public.payment_transactions set status='partially_refunded',refunded_cents=100 where id='84000000-0000-4000-8000-000000000002';
select is(public.listing_available_dates('83000000-0000-4000-8000-000000000001'),array[current_date+8],'A partial refund does not release the booking');
update public.payment_transactions set status='refunded',refunded_cents=10500 where id='84000000-0000-4000-8000-000000000002';
update public.campaign_requests set status='refunded' where listing_id='83000000-0000-4000-8000-000000000001' and status='confirmed';
select is(public.listing_available_dates('83000000-0000-4000-8000-000000000001'),array[current_date+3,current_date+4,current_date+8],'A fully refunded booking releases its dates');
select throws_like($$select public.reserve_listing_booking('83000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002',current_date+8,now()-interval '1 day',false)$$,'%listing changed%','Stale terms must be reviewed again');
reset role;
update public.profiles set is_internal=true where id='82000000-0000-4000-8000-000000000001';
select is(public.listing_available_dates('83000000-0000-4000-8000-000000000001'),'{}'::date[],'Public calendar does not expose internal inventory');
set local role service_role;
select throws_like($$select pg_temp.book(8)$$,'%owner needs to confirm%','Internal owners cannot sell through the server RPC');
reset role;
select * from finish();
rollback;
