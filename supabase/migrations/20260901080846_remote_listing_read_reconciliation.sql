-- The linked project has this migration version in its history, but the
-- original checkout is not present locally. The only observable schema
-- addition in the hosted dump is this owner-listing SELECT policy. Recreate
-- that state for fresh databases; the later payment-security migration drops
-- it after replacing direct reads with public and owner-scoped projections.
drop policy if exists "Members read their own listings" on public.listings;
create policy "Members read their own listings"
on public.listings for select to authenticated
using (
  exists (
    select 1
    from public.profiles profile
    where profile.id = listings.owner_profile_id
      and profile.auth_user_id = (select auth.uid())
  )
);
