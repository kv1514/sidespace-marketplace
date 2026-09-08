begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- listing_cooccurrence() answers "people who opened that opened this". These
-- are the two halves of that: it must count openings and not scrolls, and it
-- must never let anyone read the events it counts.

select ok(
  has_function_privilege('anon', 'public.listing_cooccurrence(uuid[])', 'execute'),
  'co-visit counts are public, because they name no one'
);
select ok(
  not has_table_privilege('anon', 'public.listing_events', 'select'),
  'the raw events behind them stay unreadable to anonymous clients'
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
  ('c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'cooc-owner@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, is_demo, onboarding_complete, suspended_at
)
values
  ('c2000000-0000-4000-8000-000000000001',
   'c1000000-0000-4000-8000-000000000001', 'creator', 'Cooc Owner', false, true, null);

alter table public.listings disable trigger listings_enforce_provenance;
insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description,
  status, provenance_status, availability_confirmed_at
)
values
  ('c3000000-0000-4000-8000-000000000001',
   'c2000000-0000-4000-8000-000000000001',
   'The seed listing', 'Instagram', 'One post', 10000,
   'The listing whose co-visits are being asked about.',
   'active', 'owner_attested', now()),
  ('c3000000-0000-4000-8000-000000000002',
   'c2000000-0000-4000-8000-000000000001',
   'Opened by the same person', 'Instagram', 'One post', 10000,
   'Someone who opened the seed also opened this one.',
   'active', 'owner_attested', now()),
  ('c3000000-0000-4000-8000-000000000003',
   'c2000000-0000-4000-8000-000000000001',
   'Only ever scrolled past', 'Vehicle', 'A window poster', 5000,
   'Every visitor saw this card on the grid; nobody opened it.',
   'active', 'owner_attested', now());
alter table public.listings enable trigger listings_enforce_provenance;

-- One visitor opened the seed and listing two. Both of them, and everyone
-- else, scrolled past listing three - which is what the marketplace grid does
-- to every card on the page, and is exactly the signal that must not count.
insert into public.listing_events (listing_id, kind, visitor_key, day)
values
  ('c3000000-0000-4000-8000-000000000001', 'click', 'cooc-a', (now() at time zone 'utc')::date),
  ('c3000000-0000-4000-8000-000000000002', 'click', 'cooc-a', (now() at time zone 'utc')::date),
  ('c3000000-0000-4000-8000-000000000001', 'impression', 'cooc-a', (now() at time zone 'utc')::date),
  ('c3000000-0000-4000-8000-000000000002', 'impression', 'cooc-a', (now() at time zone 'utc')::date),
  ('c3000000-0000-4000-8000-000000000003', 'impression', 'cooc-a', (now() at time zone 'utc')::date),
  ('c3000000-0000-4000-8000-000000000001', 'impression', 'cooc-b', (now() at time zone 'utc')::date),
  ('c3000000-0000-4000-8000-000000000003', 'impression', 'cooc-b', (now() at time zone 'utc')::date);

set local role anon;

select is(
  (select visitors from public.listing_cooccurrence(
     array['c3000000-0000-4000-8000-000000000001']::uuid[])
    where listing_id = 'c3000000-0000-4000-8000-000000000002'
      and paired_listing_id = 'c3000000-0000-4000-8000-000000000001'),
  1::bigint,
  'one person opened both, so the pair counts once'
);

-- The whole point. Visitor cooc-b scrolled past the seed and listing three in
-- the same session, and cooc-a scrolled past all three. If impressions counted,
-- listing three would pair with the seed here.
select is(
  (select count(*)::integer from public.listing_cooccurrence(
     array['c3000000-0000-4000-8000-000000000001']::uuid[])
    where listing_id = 'c3000000-0000-4000-8000-000000000003'),
  0,
  'a listing only ever scrolled past never becomes a co-visit'
);

select is(
  (select visitors from public.listing_cooccurrence(
     array['c3000000-0000-4000-8000-000000000001']::uuid[])
    where listing_id = 'c3000000-0000-4000-8000-000000000001'
      and paired_listing_id = 'c3000000-0000-4000-8000-000000000001'),
  1::bigint,
  'the denominator counts openings too, so the cosine compares like with like'
);

select is(
  (select count(*)::integer
     from information_schema.columns
    where table_schema = 'public' and table_name = 'listing_cooccurrence'),
  0,
  'the function exposes no column that could carry a visitor'
);

reset role;
select * from finish();
rollback;
