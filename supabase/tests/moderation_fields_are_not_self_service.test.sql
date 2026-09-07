begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- Two administrative fields a member must not be able to set about themselves.
-- Both are reachable through a table-level UPDATE grant that the row policies
-- do not narrow, so these assertions are about the triggers, not the policies.
--
-- Two members on purpose: suspension is what the first one is for, and a
-- suspended member cannot pass the insert policy on listings, so the curation
-- assertions need somebody in good standing.

select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.listings'::regclass
      and tgname = 'listings_protect_curation'
      and not tgisinternal
  ),
  'a listing carries the curation guard'
);
select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.profiles'::regclass
      and tgname = 'profiles_protect_trust_fields'
      and not tgisinternal
  ),
  'and a profile still carries the trust guard'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('d1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'suspended@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('d1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'in-good-standing@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, onboarding_complete, city
)
values
  ('d2000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', 'creator', 'Suspended', true, 'Berkeley'),
  ('d2000000-0000-4000-8000-000000000002',
   'd1000000-0000-4000-8000-000000000002', 'creator', 'Good Standing', true, 'Berkeley');

insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, price_unit,
  description, status
)
values ('d3000000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000002', 'A listing', 'instagram', 'post',
  5000, 'per post', 'Something for sale.', 'active');

-- The founders suspend one member and feature one listing, the way the Slack
-- commands and the founder tooling do: as the service role.
update public.profiles
set suspended_at = now(), suspended_reason = 'Obscene listings'
where id = 'd2000000-0000-4000-8000-000000000001';
update public.listings set featured_rank = 3
where id = 'd3000000-0000-4000-8000-000000000001';

select isnt(
  (select suspended_at from public.profiles
   where id = 'd2000000-0000-4000-8000-000000000001'),
  null,
  'the service role can suspend a member'
);
select is(
  (select featured_rank from public.listings
   where id = 'd3000000-0000-4000-8000-000000000001'),
  3,
  'and can feature a listing'
);

-- The suspended member, holding nothing but their own session.
select set_config(
  'request.jwt.claims',
  '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
set local role authenticated;
-- The write is allowed to succeed. The trigger discards the value rather than
-- refusing the statement: refusing would tell a suspended member exactly which
-- column to go looking for, and would break an ordinary profile save that
-- happens to round-trip the field.
select lives_ok(
  $$update public.profiles
    set suspended_at = null, suspended_reason = null, city = 'Oakland'
    where id = 'd2000000-0000-4000-8000-000000000001'$$,
  'a member may write their own profile row'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select isnt(
  (select suspended_at from public.profiles
   where id = 'd2000000-0000-4000-8000-000000000001'),
  null,
  'but cannot lift their own suspension'
);
select is(
  (select suspended_reason from public.profiles
   where id = 'd2000000-0000-4000-8000-000000000001'),
  'Obscene listings',
  'and cannot erase why'
);
select is(
  (select city from public.profiles
   where id = 'd2000000-0000-4000-8000-000000000001'),
  'Oakland',
  'while the rest of their write lands as usual'
);

-- The owner in good standing, on their own listing.
select set_config(
  'request.jwt.claims',
  '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
set local role authenticated;
select lives_ok(
  $$update public.listings set featured_rank = 1, title = 'A listing, renamed'
    where id = 'd3000000-0000-4000-8000-000000000001'$$,
  'an owner may write their own listing row'
);
select lives_ok(
  $$insert into public.listings (
      id, owner_profile_id, title, channel, format, price_cents, price_unit,
      description, status, featured_rank
    ) values (
      'd3000000-0000-4000-8000-000000000002',
      'd2000000-0000-4000-8000-000000000002', 'Born featured', 'instagram',
      'post', 5000, 'per post', 'Nice try.', 'active', 1
    )$$,
  'and may create one'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select featured_rank from public.listings
   where id = 'd3000000-0000-4000-8000-000000000001'),
  3,
  'but cannot pin an existing listing to the top of the marketplace'
);
select is(
  (select title from public.listings
   where id = 'd3000000-0000-4000-8000-000000000001'),
  'A listing, renamed',
  'while the rest of that write lands as usual'
);
select is(
  (select featured_rank from public.listings
   where id = 'd3000000-0000-4000-8000-000000000002'),
  null,
  'and cannot publish one that is born featured'
);

select * from finish();
rollback;
