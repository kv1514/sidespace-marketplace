-- Listing likes are lightweight, one-per-member signals. The aggregate view is
-- public, while the underlying user-to-listing relationship stays private.

create or replace function private.profile_is_demo(target_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select profile.is_demo
    from public.profiles profile
    where profile.id = target_profile_id
  ), false);
$$;

revoke all on function private.profile_is_demo(uuid) from public;
grant execute on function private.profile_is_demo(uuid) to anon, authenticated;

create table if not exists public.listing_likes (
  listing_id uuid not null references public.listings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (listing_id, user_id)
);

create index if not exists listing_likes_user_created_idx
  on public.listing_likes (user_id, created_at desc);

alter table public.listing_likes enable row level security;

revoke all on table public.listing_likes from public, anon, authenticated;
grant select, insert, delete on table public.listing_likes to authenticated;
grant all on table public.listing_likes to service_role;

drop policy if exists "Members read their own listing likes" on public.listing_likes;
create policy "Members read their own listing likes"
on public.listing_likes for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists "Signed-in members like active listings" on public.listing_likes;
create policy "Signed-in members like active listings"
on public.listing_likes for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.listings listing
    where listing.id = listing_likes.listing_id
      and listing.status = 'active'
      and not private.profile_is_internal(listing.owner_profile_id)
      and not private.profile_is_demo(listing.owner_profile_id)
      and not private.profile_owned_by_current_user(listing.owner_profile_id)
  )
);

drop policy if exists "Members remove their own listing likes" on public.listing_likes;
create policy "Members remove their own listing likes"
on public.listing_likes for delete to authenticated
using (user_id = (select auth.uid()));

drop view if exists public.listing_like_counts;
create view public.listing_like_counts
with (security_barrier = true)
as
select
  listing.id as listing_id,
  count(like_row.user_id)::bigint as like_count
from public.listings listing
left join public.listing_likes like_row
  on like_row.listing_id = listing.id
where listing.status = 'active'
  and not private.profile_is_internal(listing.owner_profile_id)
  and not private.profile_is_demo(listing.owner_profile_id)
group by listing.id;

revoke all on table public.listing_like_counts from public, anon, authenticated;
grant select on table public.listing_like_counts to anon, authenticated;
