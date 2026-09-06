begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
-- The pgTAP runner mounts test files separately from migrations, so keep the
-- migration's DDL prelude here as well. The surrounding transaction rolls it
-- back after the assertions complete.
create or replace function private.verifiable_profile_owned_by_current_user(
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
      and profile.onboarding_complete
      and profile.role <> 'consumer'
  );
$$;

revoke all on function private.verifiable_profile_owned_by_current_user(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.verifiable_profile_owned_by_current_user(uuid)
  to authenticated;

drop policy if exists "Members read their verification request"
  on public.verification_requests;
create policy "Members read their verification request"
on public.verification_requests for select to authenticated
using (private.profile_owned_by_current_user(profile_id));

drop policy if exists "Members submit their verification request"
  on public.verification_requests;
create policy "Members submit their verification request"
on public.verification_requests for insert to authenticated
with check (
  status = 'pending'
  and private.verifiable_profile_owned_by_current_user(profile_id)
);

drop policy if exists "Members read their blocks" on public.profile_blocks;
create policy "Members read their blocks"
on public.profile_blocks for select to authenticated
using (private.profile_owned_by_current_user(blocker_profile_id));

drop policy if exists "Members block profiles" on public.profile_blocks;
create policy "Members block profiles"
on public.profile_blocks for insert to authenticated
with check (private.profile_owned_by_current_user(blocker_profile_id));

drop policy if exists "Members remove their blocks" on public.profile_blocks;
create policy "Members remove their blocks"
on public.profile_blocks for delete to authenticated
using (private.profile_owned_by_current_user(blocker_profile_id));

drop policy if exists "Members submit profile reports" on public.profile_reports;
create policy "Members submit profile reports"
on public.profile_reports for insert to authenticated
with check (
  status = 'open'
  and private.profile_owned_by_current_user(reporter_profile_id)
);

drop policy if exists "Members read their submitted reports"
  on public.profile_reports;
create policy "Members read their submitted reports"
on public.profile_reports for select to authenticated
using (private.profile_owned_by_current_user(reporter_profile_id));
select no_plan();

-- The boundary these policies have to respect: the browser roles never read
-- auth_user_id, so no policy may prove ownership by reading it inline.
select ok(
  not has_column_privilege(
    'authenticated', 'public.profiles', 'auth_user_id', 'select'
  ),
  'authenticated members cannot read profiles.auth_user_id directly'
);
select ok(
  not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename in ('verification_requests', 'profile_blocks', 'profile_reports')
      and (coalesce(qual, '') ilike '%auth_user_id%'
        or coalesce(with_check, '') ilike '%auth_user_id%')
  ),
  'trust policies use the owner helper instead of the private auth_user_id column'
);
select ok(
  has_function_privilege(
    'authenticated',
    'private.verifiable_profile_owned_by_current_user(uuid)',
    'execute'
  ),
  'authenticated members can reach the private verification helper'
);
select ok(
  not has_function_privilege(
    'anon',
    'private.verifiable_profile_owned_by_current_user(uuid)',
    'execute'
  ),
  'anonymous visitors cannot reach the private verification helper'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('b1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'trust-creator@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('b1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'trust-business@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('b1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
   'trust-shopper@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, onboarding_complete
)
values
  ('b2000000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000001', 'creator', 'Trust Creator', true),
  ('b2000000-0000-4000-8000-000000000002',
   'b1000000-0000-4000-8000-000000000002', 'business', 'Trust Business', true),
  ('b2000000-0000-4000-8000-000000000003',
   'b1000000-0000-4000-8000-000000000003', 'consumer', 'Trust Shopper', true);

-- The creator, signed in.
select set_config(
  'request.jwt.claims',
  '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
set local role authenticated;

select lives_ok(
  $$select * from public.verification_requests
    where profile_id = 'b2000000-0000-4000-8000-000000000001'$$,
  'a member can look up their verification request without reading auth_user_id'
);
select lives_ok(
  $$insert into public.verification_requests (
      profile_id, verification_type, evidence_url, status
    ) values (
      'b2000000-0000-4000-8000-000000000001', 'creator',
      'https://example.com/creator', 'pending'
    )$$,
  'a creator can submit a verification request'
);
select is(
  (select count(*)::integer from public.verification_requests),
  1,
  'the creator can see their own verification request'
);
select throws_ok(
  $$insert into public.verification_requests (
      profile_id, verification_type, status
    ) values (
      'b2000000-0000-4000-8000-000000000002', 'business', 'pending'
    )$$,
  '42501',
  'a member cannot submit a verification request for another profile'
);

select lives_ok(
  $$insert into public.profile_blocks (blocker_profile_id, blocked_profile_id)
    values (
      'b2000000-0000-4000-8000-000000000001',
      'b2000000-0000-4000-8000-000000000002'
    )$$,
  'a member can block another member'
);
select is(
  (select count(*)::integer from public.profile_blocks),
  1,
  'the member can see their own block'
);
select throws_ok(
  $$insert into public.profile_blocks (blocker_profile_id, blocked_profile_id)
    values (
      'b2000000-0000-4000-8000-000000000002',
      'b2000000-0000-4000-8000-000000000003'
    )$$,
  '42501',
  'a member cannot block on behalf of another profile'
);

select lives_ok(
  $$insert into public.profile_reports (
      reporter_profile_id, reported_profile_id, reason, details, status
    ) values (
      'b2000000-0000-4000-8000-000000000001',
      'b2000000-0000-4000-8000-000000000002',
      'spam', 'Keeps sending the same offer.', 'open'
    )$$,
  'a member can report a profile'
);
select is(
  (select count(*)::integer from public.profile_reports),
  1,
  'the member can see their own report'
);
select throws_ok(
  $$insert into public.profile_reports (
      reporter_profile_id, reported_profile_id, reason, status
    ) values (
      'b2000000-0000-4000-8000-000000000002',
      'b2000000-0000-4000-8000-000000000001',
      'spam', 'open'
    )$$,
  '42501',
  'a member cannot report on behalf of another profile'
);
select throws_ok(
  $$insert into public.profile_reports (
      reporter_profile_id, reported_profile_id, reason, status
    ) values (
      'b2000000-0000-4000-8000-000000000001',
      'b2000000-0000-4000-8000-000000000003',
      'spam', 'resolved'
    )$$,
  '42501',
  'a report has to start open'
);

-- Another member, signed in.
select set_config(
  'request.jwt.claims',
  '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select is(
  (select count(*)::integer from public.verification_requests),
  0,
  'another member cannot see the creator verification request'
);
select is(
  (select count(*)::integer from public.profile_blocks),
  0,
  'another member cannot see the creator blocks'
);
select is(
  (select count(*)::integer from public.profile_reports),
  0,
  'another member cannot see the creator reports'
);
select lives_ok(
  $$delete from public.profile_blocks
    where blocker_profile_id = 'b2000000-0000-4000-8000-000000000001'$$,
  'a delete aimed at another member blocks is filtered rather than refused'
);

-- Back to the creator: the block survived, and they can remove it themselves.
select set_config(
  'request.jwt.claims',
  '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select is(
  (select count(*)::integer from public.profile_blocks),
  1,
  'another member could not remove the creator block'
);
select lives_ok(
  $$delete from public.profile_blocks
    where blocker_profile_id = 'b2000000-0000-4000-8000-000000000001'
      and blocked_profile_id = 'b2000000-0000-4000-8000-000000000002'$$,
  'a member can remove their own block'
);
select is(
  (select count(*)::integer from public.profile_blocks),
  0,
  'the block is gone'
);

-- A consumer, signed in: verification stays closed to them.
select set_config(
  'request.jwt.claims',
  '{"sub":"b1000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select throws_ok(
  $$insert into public.verification_requests (
      profile_id, verification_type, status
    ) values (
      'b2000000-0000-4000-8000-000000000003', 'creator', 'pending'
    )$$,
  '42501',
  'a consumer cannot request verification'
);

reset role;
select * from finish();
rollback;
