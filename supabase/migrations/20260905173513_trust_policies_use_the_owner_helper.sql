-- Members could not read or submit a verification request, block or unblock
-- another member, or report a profile. Every one of those requests failed
-- with "permission denied for table profiles" (a 403 from the Data API).
--
-- 20260901151530 removed the authenticated table-wide SELECT grant on
-- public.profiles on purpose and keeps auth_user_id private. The seven
-- policies below still date from 0009 and prove ownership by reading that
-- column inline, so Postgres rejects the policy itself before the owner check
-- can run. The listing and portfolio policies moved to the private owner
-- helper in 20260901151530 and 20260903220218; this does the same for the
-- trust tables. Semantics are unchanged: the helper is the same "this profile
-- belongs to the signed-in member" test, evaluated inside a locked-down
-- SECURITY DEFINER function with a fixed search_path.
--
-- The payment_transactions, payment_refunds and payment_disputes SELECT
-- policies have the same shape, but no browser role holds SELECT on those
-- tables, so they are unreachable and are left alone here.

-- Verification is open to members who finished onboarding and are not
-- consumers. Keep that next to the owner check, in one helper, so the policy
-- never has to read profiles itself.
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
