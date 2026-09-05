-- Seven-day reach per listing, for ranking.
--
-- The recommender weights likes; the founders also want views in there. Views
-- live in public.listing_events, which no role may read - that is the whole
-- point of that table's grants, and it stays that way. What ranking needs is
-- a number per listing, never a row, so this is an aggregate behind a
-- SECURITY DEFINER function, the same arrangement as listing_cooccurrence and
-- the same promise as listing_like_counts: counts, never a person.
--
-- Only the seven-day windows are exposed. Ranking wants recency - a listing
-- has to keep earning its place, or a viral week would pin it to the top of
-- the grid for good - and all-time totals belong to the owner's dashboard,
-- which already has them through my_listing_analytics.
--
-- Called straight from the browser rather than sitting under a security-invoker
-- view, so like listing_cooccurrence it repeats the public visibility rules
-- itself: active, not internal, not suspended, not demo. A suspended member's
-- listing must not surface here any more than it does anywhere else.
create or replace function public.listing_reach()
returns table (
  listing_id uuid,
  impressions_7d bigint,
  clicks_7d bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select totals.listing_id, totals.impressions_7d, totals.clicks_7d
  from private.listing_event_totals() as totals
  join public.listings listing on listing.id = totals.listing_id
  where listing.status = 'active'
    and not private.profile_is_internal(listing.owner_profile_id)
    and not private.profile_is_suspended(listing.owner_profile_id)
    and not private.profile_is_demo(listing.owner_profile_id)
    and (totals.impressions_7d > 0 or totals.clicks_7d > 0);
$$;

revoke all on function public.listing_reach()
  from public, anon, authenticated, service_role;
grant execute on function public.listing_reach()
  to anon, authenticated, service_role;

comment on function public.listing_reach() is
  'Seven-day impression and click counts per publicly visible listing, for ranking. Returns listing ids and counts only - never a visitor key, a user, or a row - and repeats the public visibility rules itself because it is called directly rather than through a security-invoker view.';
