-- Five stars per listing, replacing the heart.
--
-- A heart asked "did anybody like this at all". Every listing with one loyal
-- friend won it, it could only ever go up, and it gave a business scanning the
-- grid nothing to choose with. A star asks how good the placement was, and it
-- can go down.
--
-- The shape is deliberately the shape of listing_likes, because the promise is
-- the same one: the row saying who rated what stays private to its rater, and
-- the browser reads an aggregate that counts people without naming them. What
-- is new is that a rating is UPDATEABLE - a heart was on or off, a verdict gets
-- revised - so this table carries updated_at and an update policy that
-- listing_likes had no need for.
--
-- WHO CAN RATE. Not the owner, not a demo account, and not on a listing that
-- is paused, internal or suspended - the same visibility rules every other
-- public read here repeats. The insert policy enforces it and so does the
-- update policy, so a listing that leaves the catalogue freezes its ratings
-- rather than letting them be edited after the fact.

create table if not exists public.listing_ratings (
  listing_id uuid not null references public.listings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  stars smallint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (listing_id, user_id),
  constraint listing_ratings_stars_are_one_to_five check (stars between 1 and 5)
);

comment on table public.listing_ratings is
  'One member''s 1-5 star rating of one listing. Private to its rater; the public aggregate is listing_rating_stats. An owner cannot rate their own listing - see the insert policy.';

create index if not exists listing_ratings_user_created_idx
  on public.listing_ratings (user_id, created_at desc);

-- The aggregate view's only query is "every active listing's count and sum".
create index if not exists listing_ratings_listing_idx
  on public.listing_ratings (listing_id);

alter table public.listing_ratings enable row level security;

revoke all on table public.listing_ratings from public, anon, authenticated;
grant select, insert, update, delete on table public.listing_ratings to authenticated;
grant all on table public.listing_ratings to service_role;

drop policy if exists "Members read their own listing ratings" on public.listing_ratings;
create policy "Members read their own listing ratings"
on public.listing_ratings for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists "Signed-in members rate active listings" on public.listing_ratings;
create policy "Signed-in members rate active listings"
on public.listing_ratings for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.listings listing
    where listing.id = listing_ratings.listing_id
      and listing.status = 'active'
      and not private.profile_is_internal(listing.owner_profile_id)
      and not private.profile_is_demo(listing.owner_profile_id)
      and not private.profile_owned_by_current_user(listing.owner_profile_id)
  )
);

-- Revising a verdict is the one thing a heart could not do. Same conditions as
-- casting it, so a rating cannot be edited onto a listing that has since been
-- paused or suspended.
drop policy if exists "Members revise their own listing ratings" on public.listing_ratings;
create policy "Members revise their own listing ratings"
on public.listing_ratings for update to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.listings listing
    where listing.id = listing_ratings.listing_id
      and listing.status = 'active'
      and not private.profile_is_internal(listing.owner_profile_id)
      and not private.profile_is_demo(listing.owner_profile_id)
      and not private.profile_owned_by_current_user(listing.owner_profile_id)
  )
);

drop policy if exists "Members withdraw their own listing ratings" on public.listing_ratings;
create policy "Members withdraw their own listing ratings"
on public.listing_ratings for delete to authenticated
using (user_id = (select auth.uid()));

create or replace function private.touch_listing_rating()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists listing_ratings_touch_updated_at on public.listing_ratings;
create trigger listing_ratings_touch_updated_at
  before update on public.listing_ratings
  for each row execute function private.touch_listing_rating();

-- The count and the sum, never the average: the mean is computed in one place
-- in the app (lib/listings/ratings.ts) so the number in the label and the
-- number in the ranking cannot drift apart through rounding.
drop view if exists public.listing_rating_stats;
create view public.listing_rating_stats
with (security_barrier = true)
as
select
  listing.id as listing_id,
  count(rating.user_id)::bigint as rating_count,
  coalesce(sum(rating.stars), 0)::bigint as rating_sum
from public.listings listing
left join public.listing_ratings rating
  on rating.listing_id = listing.id
where listing.status = 'active'
  and not private.profile_is_internal(listing.owner_profile_id)
  and not private.profile_is_demo(listing.owner_profile_id)
group by listing.id;

revoke all on table public.listing_rating_stats from public, anon, authenticated;
grant select on table public.listing_rating_stats to anon, authenticated;
