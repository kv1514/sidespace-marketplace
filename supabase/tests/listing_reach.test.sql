begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- listing_reach() exists so the grid can weight views without anyone being
-- able to read a view. These are the two halves of that promise.

select ok(
  has_function_privilege('anon', 'public.listing_reach()', 'execute'),
  'seven-day reach is public, because it names no one'
);
select ok(
  not has_table_privilege('anon', 'public.listing_events', 'select'),
  'the raw events behind it stay unreadable to anonymous clients'
);
select ok(
  not has_table_privilege('authenticated', 'public.listing_events', 'select'),
  'and to signed-in members'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('b1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'reach-owner@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('b1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'reach-suspended@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('b1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
   'reach-demo@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, is_demo, onboarding_complete, suspended_at
)
values
  ('b2000000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000001', 'creator', 'Reach Owner', false, true, null),
  ('b2000000-0000-4000-8000-000000000002',
   'b1000000-0000-4000-8000-000000000002', 'creator', 'Reach Suspended', false, true, now()),
  ('b2000000-0000-4000-8000-000000000003',
   'b1000000-0000-4000-8000-000000000003', 'creator', 'Reach Demo', true, true, null);

alter table public.listings disable trigger listings_enforce_provenance;
insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description,
  status, provenance_status, availability_confirmed_at
)
values
  ('b3000000-0000-4000-8000-000000000001',
   'b2000000-0000-4000-8000-000000000001',
   'A live listing people reached', 'Instagram', 'One post', 10000,
   'A detailed listing fixture with some seven-day traffic behind it.',
   'active', 'owner_attested', now()),
  ('b3000000-0000-4000-8000-000000000002',
   'b2000000-0000-4000-8000-000000000001',
   'A paused listing', 'Instagram', 'One post', 10000,
   'Paused listings are not in the marketplace and must not rank there.',
   'paused', 'owner_attested', now()),
  ('b3000000-0000-4000-8000-000000000003',
   'b2000000-0000-4000-8000-000000000002',
   'A suspended member''s listing', 'Vehicle', 'A window poster', 5000,
   'The owner is suspended, so this must not surface anywhere public.',
   'active', 'owner_attested', now()),
  ('b3000000-0000-4000-8000-000000000004',
   'b2000000-0000-4000-8000-000000000003',
   'A demo listing', 'Vehicle', 'A window poster', 5000,
   'Sample content is not ranked against members.',
   'active', 'owner_attested', now());
alter table public.listings enable trigger listings_enforce_provenance;

-- Three visitors reached the live listing this week, one of them opened it,
-- and one more reached it a month ago. Every other listing also has traffic,
-- which is exactly what must not leak out.
insert into public.listing_events (listing_id, kind, visitor_key, day)
values
  ('b3000000-0000-4000-8000-000000000001', 'impression', 'reach-a', (now() at time zone 'utc')::date),
  ('b3000000-0000-4000-8000-000000000001', 'impression', 'reach-b', (now() at time zone 'utc')::date - 2),
  ('b3000000-0000-4000-8000-000000000001', 'impression', 'reach-c', (now() at time zone 'utc')::date - 5),
  ('b3000000-0000-4000-8000-000000000001', 'impression', 'reach-old', (now() at time zone 'utc')::date - 30),
  ('b3000000-0000-4000-8000-000000000001', 'click', 'reach-a', (now() at time zone 'utc')::date),
  ('b3000000-0000-4000-8000-000000000002', 'impression', 'reach-a', (now() at time zone 'utc')::date),
  ('b3000000-0000-4000-8000-000000000003', 'impression', 'reach-a', (now() at time zone 'utc')::date),
  ('b3000000-0000-4000-8000-000000000004', 'impression', 'reach-a', (now() at time zone 'utc')::date);

set local role anon;

select is(
  (select impressions_7d from public.listing_reach()
    where listing_id = 'b3000000-0000-4000-8000-000000000001'),
  3::bigint,
  'seven-day impressions count distinct recent visitors and leave the old one out'
);
select is(
  (select clicks_7d from public.listing_reach()
    where listing_id = 'b3000000-0000-4000-8000-000000000001'),
  1::bigint,
  'seven-day clicks count the one who opened it'
);
select is(
  (select count(*)::integer from public.listing_reach()
    where listing_id in (
      'b3000000-0000-4000-8000-000000000002',
      'b3000000-0000-4000-8000-000000000003',
      'b3000000-0000-4000-8000-000000000004'
    )),
  0,
  'paused, suspended-owner and demo listings do not surface, traffic or not'
);
select is(
  (select count(*)::integer
     from information_schema.columns
    where table_schema = 'public' and table_name = 'listing_reach'),
  0,
  'the function exposes no column that could carry a visitor'
);

reset role;
select * from finish();
rollback;
