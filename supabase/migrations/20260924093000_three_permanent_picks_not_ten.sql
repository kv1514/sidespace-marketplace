-- Three hand-picked listings at the top, permanently, and nothing below them.
--
-- 20260906140000 added featured_rank as temporary curation for a catalogue too
-- small for the ranking to carry the page, and ten listings ended up carrying a
-- rank. Ten is most of the first screen: the grid's first ten cards were a
-- hand-written list, personalisation decided only the tail, and reading the
-- live marketplace told you almost nothing about what the ranking was doing.
--
-- Three is a storefront, not a substitute for the model. The first three cards
-- are the founders' pick of the best inventory - the listings that say in one
-- glance what SideSpace is for - and everything from the fourth card down is
-- now earned: stars first, then how well the listing answers what the visitor
-- typed, then traffic.
--
-- WHO CAN SET IT is unchanged: nobody but the service role. There is still no
-- insert or update grant on the column, so an owner cannot pin themselves.

update public.listings
  set featured_rank = null
  where featured_rank is not null
    and featured_rank > 3;

-- The ceiling is the invariant now, not a convention. "The top three are
-- permanent" is only true if a fourth pin cannot be added without a migration;
-- widening it again is one alter table, and clearing all three still hands the
-- whole page back to the ranking with no code change.
alter table public.listings
  drop constraint if exists listings_featured_rank_is_a_small_position;
alter table public.listings
  add constraint listings_featured_rank_is_a_small_position
  check (featured_rank is null or featured_rank between 1 and 3);

comment on column public.listings.featured_rank is
  'Permanent position in the first three cards of the marketplace: 1 is first, null is not picked. Writable only by the service role - an owner must never be able to feature themselves. Capped at three by listings_featured_rank_is_a_small_position; clearing all three hands the order back to the ranking model.';
