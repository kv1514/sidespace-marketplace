-- "People who looked at that looked at this."
--
-- The item-to-item half of the recommender. For a handful of listings someone
-- has shown interest in, it answers: which other listings did the same people
-- look at, and how many of them.
--
-- WHAT IT RETURNS AND WHY THAT IS SAFE
--
-- Listing ids and counts. Never a visitor_key, never a user id, never a row.
-- The join happens inside a SECURITY DEFINER function because no role can read
-- public.listing_events - that is the whole point of the table's grants - and
-- an aggregate over data nobody may see is the only way to get this number out
-- without exposing who generated it.
--
-- Unlike private.listing_like_totals(), this one is called straight from the
-- browser rather than sitting under a security-invoker view, so it cannot lean
-- on the listings policy to decide what is visible. It therefore repeats the
-- visibility rules itself: active, not internal, not suspended, not demo, on
-- BOTH sides of every pair. A suspended member's listing id must not surface
-- here any more than it does anywhere else.
--
-- A row where listing_id = paired_listing_id carries that listing's own
-- distinct-visitor total, which is the denominator the caller needs to turn
-- raw pair counts into a cosine. Returning it here saves a second round trip.
--
-- On today's data this returns nothing at all: 19 listings and no recorded
-- events means no pair has ever co-occurred. It is written now so that the
-- moment real traffic exists the recommendation quality improves without a
-- deploy.
create or replace function public.listing_cooccurrence(seed_ids uuid[])
returns table (
  listing_id uuid,
  paired_listing_id uuid,
  visitors bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with seeds as (
    select distinct seed.id
    from unnest(coalesce(seed_ids, array[]::uuid[])) as seed(id)
    limit 20
  ),
  visible as (
    select listing.id
    from public.listings listing
    where listing.status = 'active'
      and not private.profile_is_internal(listing.owner_profile_id)
      and not private.profile_is_suspended(listing.owner_profile_id)
      and not private.profile_is_demo(listing.owner_profile_id)
  ),
  -- Every listing a seed's visitors also reached.
  pairs as (
    select
      other.listing_id as listing_id,
      mine.listing_id as paired_listing_id,
      count(distinct other.visitor_key)::bigint as visitors
    from public.listing_events mine
    join public.listing_events other
      on other.visitor_key = mine.visitor_key
     and other.listing_id <> mine.listing_id
    where mine.listing_id in (select id from seeds)
      and mine.listing_id in (select id from visible)
      and other.listing_id in (select id from visible)
    group by other.listing_id, mine.listing_id
  ),
  -- The denominators, for the listings the pairs actually mention.
  totals as (
    select
      event.listing_id,
      event.listing_id as paired_listing_id,
      count(distinct event.visitor_key)::bigint as visitors
    from public.listing_events event
    where event.listing_id in (select id from visible)
      and (
        event.listing_id in (select pairs.listing_id from pairs)
        or event.listing_id in (select pairs.paired_listing_id from pairs)
      )
    group by event.listing_id
  )
  select * from pairs
  union all
  select * from totals;
$$;

revoke all on function public.listing_cooccurrence(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.listing_cooccurrence(uuid[])
  to anon, authenticated, service_role;

comment on function public.listing_cooccurrence(uuid[]) is
  'Item-to-item co-visit counts for up to 20 seed listings. Returns listing ids and visitor counts only - never a visitor key, a user, or a row - and repeats the public visibility rules on both sides of every pair because it is called directly rather than through a security-invoker view.';
