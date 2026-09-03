begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
-- The pgTAP runner mounts test files separately from migrations, so keep the
-- migration's small DDL prelude here as well. The surrounding transaction
-- rolls it back after the assertions complete.
drop policy if exists "Members update their own profile" on public.profiles;
create policy "Members update their own profile"
on public.profiles for update to authenticated
using (private.profile_owned_by_current_user(id))
with check (private.profile_owned_by_current_user(id) and not is_demo);

create or replace function private.creator_profile_owned_by_current_user(
  target_profile_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = target_profile_id
      and profile.auth_user_id = (select auth.uid())
      and profile.role = 'creator'
  );
$$;

revoke all on function private.creator_profile_owned_by_current_user(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.creator_profile_owned_by_current_user(uuid)
  to authenticated;

drop policy if exists "Creators add their own portfolio items"
  on public.creator_portfolio_items;
create policy "Creators add their own portfolio items"
on public.creator_portfolio_items for insert to authenticated
with check (private.creator_profile_owned_by_current_user(creator_profile_id));

drop policy if exists "Creators update their own portfolio items"
  on public.creator_portfolio_items;
create policy "Creators update their own portfolio items"
on public.creator_portfolio_items for update to authenticated
using (private.creator_profile_owned_by_current_user(creator_profile_id))
with check (private.creator_profile_owned_by_current_user(creator_profile_id));

drop policy if exists "Creators delete their own portfolio items"
  on public.creator_portfolio_items;
create policy "Creators delete their own portfolio items"
on public.creator_portfolio_items for delete to authenticated
using (private.creator_profile_owned_by_current_user(creator_profile_id));
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('93000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'portfolio-owner@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('93000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'portfolio-other@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, onboarding_complete
)
values
  ('94000000-0000-4000-8000-000000000001',
   '93000000-0000-4000-8000-000000000001', 'creator', 'Portfolio Owner', true),
  ('94000000-0000-4000-8000-000000000002',
   '93000000-0000-4000-8000-000000000002', 'creator', 'Portfolio Other', true);

insert into public.creator_portfolio_items (
  id, creator_profile_id, title, description, project_url, published
)
values
  ('95000000-0000-4000-8000-000000000001',
   '94000000-0000-4000-8000-000000000001', 'Owner project', 'Original owner work',
   'https://example.com/owner', true),
  ('95000000-0000-4000-8000-000000000002',
   '94000000-0000-4000-8000-000000000002', 'Other project', 'Original other work',
   'https://example.com/other', true);

select ok(
  not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'Members update their own profile'
      and (coalesce(qual, '') ilike '%auth_user_id%'
        or coalesce(with_check, '') ilike '%auth_user_id%')
  ),
  'profile updates use the owner helper instead of the private auth_user_id column'
);
select ok(
  has_function_privilege(
    'authenticated',
    'private.creator_profile_owned_by_current_user(uuid)',
    'execute'
  ),
  'authenticated creators can reach the private portfolio owner helper'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"93000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
set local role authenticated;

select lives_ok(
  $$update public.profiles
    set social_links = '{"instagram":"https://instagram.com/owner"}'::jsonb
    where id = '94000000-0000-4000-8000-000000000001'$$,
  'a member can update their profile without reading auth_user_id'
);
select is(
  (select social_links->>'instagram'
   from public.my_profiles
   where id = '94000000-0000-4000-8000-000000000001'),
  'https://instagram.com/owner',
  'the profile update is persisted'
);
select lives_ok(
  $$insert into public.creator_portfolio_items (
      creator_profile_id, title, description, project_url, published
    ) values (
      '94000000-0000-4000-8000-000000000001',
      'New project', 'New owner work', 'https://example.com/new', true
    )$$,
  'a creator can add a portfolio item'
);
select lives_ok(
  $$update public.creator_portfolio_items
    set description = 'Updated owner work'
    where id = '95000000-0000-4000-8000-000000000001'$$,
  'a creator can update their portfolio item'
);
select lives_ok(
  $$delete from public.creator_portfolio_items
    where id = '95000000-0000-4000-8000-000000000001'$$,
  'a creator can delete their portfolio item'
);
select lives_ok(
  $$update public.creator_portfolio_items
    set description = 'Tampered other work'
    where id = '95000000-0000-4000-8000-000000000002'$$,
  'a creator cannot mutate another creator portfolio row'
);
select is(
  (select description from public.creator_portfolio_items
   where id = '95000000-0000-4000-8000-000000000002'),
  'Original other work',
  'another creator portfolio row remains unchanged'
);

reset role;
select * from finish();
rollback;
