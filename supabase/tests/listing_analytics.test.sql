begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- The whole promise of this feature is that an owner sees counts and nobody
-- sees a person. These assertions are that promise, written down.

select ok(
  not has_table_privilege('anon', 'public.listing_events', 'select'),
  'anonymous clients cannot read raw listing events'
);
select ok(
  not has_table_privilege('authenticated', 'public.listing_events', 'select'),
  'signed-in members cannot read raw listing events either'
);
select ok(
  not has_table_privilege('authenticated', 'public.listing_events', 'insert'),
  'the browser cannot write events directly, so counts cannot be inflated'
);
select ok(
  not has_table_privilege('anon', 'public.my_listing_analytics', 'select'),
  'anonymous visitors cannot read owner analytics'
);
select ok(
  has_table_privilege('authenticated', 'public.my_listing_analytics', 'select'),
  'signed-in members can read owner analytics'
);
select ok(
  (select reloptions @> array['security_invoker=true']
   from pg_catalog.pg_class
   where oid = 'public.my_listing_analytics'::regclass),
  'owner analytics runs as the caller, so the listings policy decides whose'
);
select ok(
  (select reloptions @> array['security_barrier=true']
   from pg_catalog.pg_class
   where oid = 'public.my_listing_analytics'::regclass),
  'owner analytics is a security-barrier view'
);
select ok(
  not has_function_privilege('anon', 'private.listing_event_totals()', 'execute'),
  'the non-exposed event aggregate is not callable by anonymous clients'
);
select ok(
  has_function_privilege('anon', 'public.listing_cooccurrence(uuid[])', 'execute'),
  'co-visit counts are public, because they name no one'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'analytics-owner@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'analytics-other@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, is_demo, onboarding_complete
)
values
  ('a2000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'creator', 'Analytics Owner', false, true),
  ('a2000000-0000-4000-8000-000000000002',
   'a1000000-0000-4000-8000-000000000002', 'creator', 'Analytics Other', false, true);

alter table public.listings disable trigger listings_enforce_provenance;
insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description,
  status, provenance_status, availability_confirmed_at
)
values
  ('a3000000-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000001',
   'The owner''s listing', 'Instagram', 'One post', 10000,
   'A detailed listing fixture used to check the owner analytics boundary.',
   'active', 'owner_attested', now()),
  ('a3000000-0000-4000-8000-000000000002',
   'a2000000-0000-4000-8000-000000000002',
   'Somebody else''s listing', 'Vehicle', 'A window poster', 5000,
   'A second owner''s listing, which the first owner must never see figures for.',
   'active', 'owner_attested', now());
alter table public.listings enable trigger listings_enforce_provenance;

-- Two people reached the owner's listing; one of them opened it. One of those
-- days is old enough to fall outside the seven-day window.
insert into public.listing_events (listing_id, kind, visitor_key, day)
values
  ('a3000000-0000-4000-8000-000000000001', 'impression', 'visitor-one',
   (now() at time zone 'utc')::date),
  ('a3000000-0000-4000-8000-000000000001', 'impression', 'visitor-two',
   (now() at time zone 'utc')::date - 30),
  ('a3000000-0000-4000-8000-000000000001', 'click', 'visitor-one',
   (now() at time zone 'utc')::date),
  ('a3000000-0000-4000-8000-000000000002', 'impression', 'visitor-nine',
   (now() at time zone 'utc')::date);

-- The same visitor twice in a day is one row, not two.
select throws_ok(
  $$insert into public.listing_events (listing_id, kind, visitor_key, day)
    values ('a3000000-0000-4000-8000-000000000001', 'impression', 'visitor-one',
            (now() at time zone 'utc')::date)$$,
  '23505',
  NULL,
  'one person scrolling past the same card twice in a day counts once'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
set local role authenticated;

select is(
  (select count(*)::integer from public.my_listing_analytics),
  1,
  'an owner sees exactly their own listings and no one else''s'
);
select is(
  (select impressions from public.my_listing_analytics
   where listing_id = 'a3000000-0000-4000-8000-000000000001'),
  2::bigint,
  'both people who reached the listing are counted'
);
select is(
  (select impressions_7d from public.my_listing_analytics
   where listing_id = 'a3000000-0000-4000-8000-000000000001'),
  1::bigint,
  'the seven-day figure excludes the visit from a month ago'
);
select is(
  (select clicks from public.my_listing_analytics
   where listing_id = 'a3000000-0000-4000-8000-000000000001'),
  1::bigint,
  'the person who opened it is counted as a click'
);
select throws_ok(
  $$select count(*) from public.listing_events$$,
  '42501',
  NULL,
  'an owner still cannot read the rows their own figures are made of'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select is(
  (select count(*)::integer from public.my_listing_analytics
   where listing_id = 'a3000000-0000-4000-8000-000000000001'),
  0,
  'a second member cannot see the first owner''s figures'
);
select is(
  (select count(*)::integer from public.my_listing_analytics),
  1,
  'they see their own listing, and only that'
);

reset role;
select * from extensions.finish();
rollback;
