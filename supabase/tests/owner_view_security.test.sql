begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select extensions.plan(12);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('85000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-view-one@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('85000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'owner-view-two@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, onboarding_complete
)
values
  ('86000000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000001', 'creator', 'Owner View One', true),
  ('86000000-0000-4000-8000-000000000002', '85000000-0000-4000-8000-000000000002', 'creator', 'Owner View Two', true);

alter table public.listings disable trigger listings_enforce_provenance;
insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description,
  street_address, provenance_status, availability_confirmed_at
)
values
  ('87000000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001', 'Owner View One Listing', 'Instagram', 'Post', 10000, 'First private listing', '111 Private Street', 'owner_attested', now()),
  ('87000000-0000-4000-8000-000000000002', '86000000-0000-4000-8000-000000000002', 'Owner View Two Listing', 'Instagram', 'Post', 10000, 'Second private listing', '222 Private Street', 'owner_attested', now());
alter table public.listings enable trigger listings_enforce_provenance;

select ok(
  (select reloptions @> array['security_invoker=true']
   from pg_catalog.pg_class
   where oid = 'public.my_profiles'::regclass),
  'the owner profile projection is a security-invoker view'
);
select ok(
  (select reloptions @> array['security_invoker=true']
   from pg_catalog.pg_class
   where oid = 'public.my_listings'::regclass),
  'the owner listing projection is a security-invoker view'
);
select ok(
  has_function_privilege(
    'authenticated', 'private.current_user_profile_rows()', 'execute'
  ),
  'authenticated members can use the private owner-profile boundary'
);
select ok(
  has_function_privilege(
    'authenticated', 'private.current_user_listing_rows()', 'execute'
  ),
  'authenticated members can use the private owner-listing boundary'
);
select ok(
  not has_function_privilege(
    'anon', 'private.current_user_profile_rows()', 'execute'
  ),
  'anonymous clients cannot execute the private owner-profile boundary'
);
select ok(
  not has_function_privilege(
    'anon', 'private.current_user_listing_rows()', 'execute'
  ),
  'anonymous clients cannot execute the private owner-listing boundary'
);
select ok(
  not has_table_privilege('anon', 'public.my_profiles', 'select'),
  'anonymous clients cannot select from the owner profile view'
);
select ok(
  not has_table_privilege('anon', 'public.my_listings', 'select'),
  'anonymous clients cannot select from the owner listing view'
);

select set_config(
  'request.jwt.claim.sub',
  '85000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

select is(
  (select count(*)::integer from public.my_profiles),
  1,
  'an authenticated member sees exactly their own profile'
);
select is(
  (select count(*)::integer
   from public.my_profiles
   where auth_user_id = '85000000-0000-4000-8000-000000000002'),
  0,
  'an authenticated member cannot see another profile'
);
select is(
  (select street_address
   from public.my_listings
   where id = '87000000-0000-4000-8000-000000000001'),
  '111 Private Street',
  'an authenticated member can read their own private listing address'
);
select is(
  (select count(*)::integer
   from public.my_listings
   where id = '87000000-0000-4000-8000-000000000002'),
  0,
  'an authenticated member cannot see another private listing'
);

reset role;
select * from extensions.finish();
rollback;
