-- The security boundary on public.profiles intentionally removes the
-- authenticated table-wide SELECT grant and keeps auth_user_id private.
-- Policies that read that column directly therefore fail before their owner
-- check can run. Use the existing owner helper instead; it is a locked-down
-- SECURITY DEFINER function in the private schema with a fixed search_path.

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
with check (
  private.creator_profile_owned_by_current_user(creator_profile_id)
);

drop policy if exists "Creators update their own portfolio items"
  on public.creator_portfolio_items;
create policy "Creators update their own portfolio items"
on public.creator_portfolio_items for update to authenticated
using (
  private.creator_profile_owned_by_current_user(creator_profile_id)
)
with check (
  private.creator_profile_owned_by_current_user(creator_profile_id)
);

drop policy if exists "Creators delete their own portfolio items"
  on public.creator_portfolio_items;
create policy "Creators delete their own portfolio items"
on public.creator_portfolio_items for delete to authenticated
using (
  private.creator_profile_owned_by_current_user(creator_profile_id)
);
