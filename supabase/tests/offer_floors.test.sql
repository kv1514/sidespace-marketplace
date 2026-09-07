begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select extensions.plan(14);

-- Two floors on what either side may put on the table: nothing under $2, and
-- nothing more than 60% below the amount the OTHER side last proposed. The
-- browser checks the same numbers first, but it writes campaign requests
-- directly, so these are the checks that actually hold.
--
-- The listing asks $900, which makes the first-offer floor $360. An offer of
-- $360 then makes the counteroffer floor $144.

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('a0000000-0000-4000-8000-000000000101', 'authenticated', 'authenticated',
   'floor-business@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('a0000000-0000-4000-8000-000000000102', 'authenticated', 'authenticated',
   'floor-creator@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, is_demo, onboarding_complete
)
values
  ('a0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000101', 'business', 'Floor Business', true, true),
  ('a0000000-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000102', 'creator', 'Floor Creator', true, true);

insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description
)
values
  ('a0000000-0000-4000-8000-000000000010',
   'a0000000-0000-4000-8000-000000000002',
   'Nine hundred dollar window', 'Instagram', 'Post', 90000, 'Floor fixture'),
  ('a0000000-0000-4000-8000-000000000011',
   'a0000000-0000-4000-8000-000000000002',
   'One dollar window', 'Instagram', 'Post', 100, 'Minimum fixture');

select is(private.offer_floor_cents(90000), 36000::bigint,
  'the floor is 40% of the amount on the table');
select is(private.offer_floor_cents(100001), 40001::bigint,
  'and rounds up, so a rounding cent cannot widen the cut');
select is(private.offer_floor_cents(100), 200::bigint,
  'while $2 is the floor under the floor');
select is(private.offer_floor_cents(0), 200::bigint,
  'including when there is no reference amount at all');

-- These fixtures are demo profiles, which the launch gate correctly keeps
-- non-requestable. That gate is not what this suite is about.
alter table public.campaign_requests
  disable trigger campaign_requests_require_requestable_listing;

create function pg_temp.offer(
  cents bigint,
  listing uuid default 'a0000000-0000-4000-8000-000000000010'
) returns uuid language sql as $$
  insert into public.campaign_requests (
    listing_id, requester_profile_id, owner_profile_id, campaign_name,
    goals, requested_deliverables, budget_cents, start_date, end_date, status
  ) values (
    listing,
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000002',
    'Floor campaign', '', 'One post', cents,
    current_date + 7, current_date + 14, 'pending'
  ) returning id;
$$;

select throws_like($$select pg_temp.offer(500)$$,
  '%more than 60%% below the $900.00 asking price%',
  'a $5 offer on a $900 listing is refused, and says what to offer instead');
select throws_like($$select pg_temp.offer(35999)$$,
  '%at least $360.00%',
  'and so is one cent under the floor');
select lives_ok($$select pg_temp.offer(36000)$$,
  'while the floor itself goes through');
select lives_ok($$select pg_temp.offer(500000)$$,
  'and asking far above the listed price is never capped');

select throws_like(
  $$select pg_temp.offer(199, 'a0000000-0000-4000-8000-000000000011')$$,
  '%Offers start at $2.00%',
  '$1.99 is refused however cheap the listing is');
select lives_ok(
  $$select pg_temp.offer(200, 'a0000000-0000-4000-8000-000000000011')$$,
  'while $2 on a $1 listing is a real offer');

-- The counteroffer side, as the owner answering the $360 offer.
create function pg_temp.counter(cents bigint) returns text language sql as $$
  select status from public.respond_campaign_request(
    (select id from public.campaign_requests where budget_cents = 36000 limit 1),
    'countered', cents, 'Here is what we can do on this one.');
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000102","role":"authenticated"}',
  true
);
set local role authenticated;

select throws_like($$select pg_temp.counter(10000)$$,
  '%more than 60%% below the $360.00 on the table%',
  'the owner cannot counter a $360 offer at $100');
select is(pg_temp.counter(14400), 'countered',
  'but 40% of it lands');
select is(pg_temp.counter(14400), 'countered',
  'and a revision is still measured against the offer, not the last counteroffer');
select is(pg_temp.counter(200000), 'countered',
  'while countering upward is never capped');

reset role;
alter table public.campaign_requests
  enable trigger campaign_requests_require_requestable_listing;

select * from finish();
rollback;
