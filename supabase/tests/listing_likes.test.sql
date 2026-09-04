begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

select ok(
  not has_table_privilege('anon', 'public.listing_likes', 'select'),
  'anonymous clients cannot read individual listing likes'
);
select ok(
  not has_table_privilege('anon', 'public.listing_likes', 'insert'),
  'anonymous clients cannot create listing likes'
);
select ok(
  has_table_privilege('authenticated', 'public.listing_likes', 'select'),
  'authenticated members can read their own listing likes'
);
select ok(
  has_table_privilege('authenticated', 'public.listing_likes', 'insert'),
  'authenticated members can create listing likes'
);
select ok(
  has_table_privilege('authenticated', 'public.listing_likes', 'delete'),
  'authenticated members can remove their own listing likes'
);
select ok(
  has_table_privilege('anon', 'public.listing_like_counts', 'select'),
  'anonymous visitors can read aggregate listing counts'
);
select ok(
  (select reloptions @> array['security_barrier=true']
   from pg_catalog.pg_class
   where oid = 'public.listing_like_counts'::regclass),
  'the public like-count projection is a security-barrier view'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'likes-owner@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'likes-member@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, is_demo, onboarding_complete
)
values
  ('a2000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'creator', 'Likes Owner', false, true),
  ('a2000000-0000-4000-8000-000000000002',
   'a1000000-0000-4000-8000-000000000002', 'business', 'Likes Member', false, true);

alter table public.listings disable trigger listings_enforce_provenance;
insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description,
  status, provenance_status, availability_confirmed_at
)
values (
  'a3000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',
  'A listing members can like', 'Instagram', 'One post', 10000,
  'A detailed listing fixture for testing the member-only like boundary.',
  'active', 'owner_attested', now()
);
alter table public.listings enable trigger listings_enforce_provenance;

select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
set local role authenticated;

select lives_ok(
  $$insert into public.listing_likes (listing_id, user_id)
    values (
      'a3000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000002'
    )$$,
  'a signed-in member can like another member''s active listing'
);
select is(
  (select count(*)::integer from public.listing_likes),
  1,
  'the member can see their own like row'
);
select is(
  (select like_count from public.listing_like_counts
   where listing_id = 'a3000000-0000-4000-8000-000000000001'),
  1::bigint,
  'the public aggregate view reports the like'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select throws_ok(
  $$insert into public.listing_likes (listing_id, user_id)
    values (
      'a3000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001'
    )$$,
  '42501',
  NULL,
  'a listing owner cannot like their own listing'
);
select is(
  (select count(*)::integer from public.listing_likes),
  0,
  'members cannot inspect another member''s like row'
);
select is(
  (select like_count from public.listing_like_counts
   where listing_id = 'a3000000-0000-4000-8000-000000000001'),
  1::bigint,
  'hiding the relationship does not hide the public aggregate'
);

reset role;
select * from extensions.finish();
rollback;
