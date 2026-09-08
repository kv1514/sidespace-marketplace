-- A co-visit is an opening, not a scroll.
--
-- listing_cooccurrence joined public.listing_events to itself with no filter
-- on kind, so an impression counted as a co-visit. An impression is the grid
-- scrolling past a card. The marketplace renders every active listing on one
-- page, so every visitor who scrolls to the bottom generates an impression for
-- every listing, and therefore co-occurs every pair with every other pair.
--
-- The result was not a weak signal. It was a uniform one. Measured on
-- production before this migration, with 627 impressions against 57 clicks:
-- every pair of live listings had co-occurred between 12 and 36 times, self
-- totals ran 16 to 61, and cooccurrenceAffinity() came back between 0.51 and
-- 0.77 for EVERY listing in the catalogue while the taste term - the thing the
-- visitor actually told us - ranged 0.03 to 0.35. At COOCCURRENCE_WEIGHT the
-- near-constant swamped the signal it was meant to support, and the quality
-- prior was left to break the tie, so whatever had the most reach scored
-- highest whoever was looking.
--
-- Scored against the live catalogue for a visitor who had opened two walls and
-- a car window, the impression-fed index put an Instagram listing they had
-- never opened above both walls; with the term removed the walls came first
-- and second. docs/marketplace-ranking.md promises exactly that - co-visits
-- are "never enough to outrank one they have plainly been choosing" - and
-- pairs/COOCCURRENCE_CONFIDENCE was supposed to damp a thin pair to a whisper,
-- but with every pair at 12+ that floor sat pinned at 1 and never engaged.
--
-- This was not visible on the marketplace today: the first ten slots are
-- hand-pinned through listings.featured_rank, which sorts ahead of
-- personalisation, so the ranking currently decides the tail of the grid. It
-- decides the whole grid the moment those pins are lifted, and it decides the
-- tail either way.
--
-- Counting only clicks restores the intent. On the same production data the
-- pairs fall from 12-36 to 1-2, under the confidence floor, so a single shared
-- opening reads as the whisper it is - and the pairs that do surface are the
-- ones a person chose to open rather than the ones the page put in front of
-- them. Re-scored after this change, that visitor's two walls rank first and
-- second and the co-visit term contributes 0.002 to 0.038.
--
-- Both sides of the join and the denominator all narrow together: a cosine
-- whose numerator counts openings and whose denominator counts scrolls would
-- be a smaller, subtler version of the same bug.
--
-- Everything else about the function is unchanged - the visibility rules on
-- both sides of every pair, the 20-seed cap, the grants, and the promise that
-- it returns listing ids and counts and never a visitor.
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
  -- Every listing a seed's visitors also OPENED.
  pairs as (
    select
      other.listing_id as listing_id,
      mine.listing_id as paired_listing_id,
      count(distinct other.visitor_key)::bigint as visitors
    from public.listing_events mine
    join public.listing_events other
      on other.visitor_key = mine.visitor_key
     and other.listing_id <> mine.listing_id
    where mine.kind = 'click'
      and other.kind = 'click'
      and mine.listing_id in (select id from seeds)
      and mine.listing_id in (select id from visible)
      and other.listing_id in (select id from visible)
    group by other.listing_id, mine.listing_id
  ),
  -- The denominators, over the same population the numerator counts.
  totals as (
    select
      event.listing_id,
      event.listing_id as paired_listing_id,
      count(distinct event.visitor_key)::bigint as visitors
    from public.listing_events event
    where event.kind = 'click'
      and event.listing_id in (select id from visible)
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
  'Item-to-item co-visit counts for up to 20 seed listings, counting openings (kind = click) and not impressions: the marketplace renders every listing on one page, so an impression-based pair count is near-uniform and says nothing. Returns listing ids and visitor counts only - never a visitor key, a user, or a row - and repeats the public visibility rules on both sides of every pair because it is called directly rather than through a security-invoker view.';
