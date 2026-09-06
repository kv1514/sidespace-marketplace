-- A hand-picked few at the top of the marketplace.
--
-- The grid is ranked by what each visitor keeps opening. That model needs
-- traffic to say anything, and with nineteen listings it mostly says nothing:
-- a first-time visitor gets a stable shuffle, which is fair and completely
-- uninformative about what SideSpace is for. Until the catalogue is big
-- enough for the ranking to carry the page on its own, the founders pick the
-- first few by hand.
--
-- Deliberately a column and not a constant in the app: this is a temporary
-- thing with a known end (roughly a hundred listings), and it has to be
-- changeable in one statement, by someone who is not deploying. Setting every
-- featured_rank back to null turns the whole mechanism off and the algorithm
-- takes the page back with no code change.
--
-- WHO CAN SET IT. Nobody but the service role. public.listings grants are
-- per column (see migration 0020), so a column with no insert or update
-- grant cannot be written by `authenticated` at all - an owner cannot pin
-- their own listing to the top of the marketplace, which is the one thing
-- this column must never allow. It is granted SELECT because the browser
-- sorts on it.
alter table public.listings
  add column if not exists featured_rank smallint;

comment on column public.listings.featured_rank is
  'Hand-picked position at the top of the marketplace: 1 is first, null is not featured. Writable only by the service role - an owner must never be able to feature themselves. Temporary curation for a small catalogue; clearing every value hands the order back to the ranking model.';

alter table public.listings
  drop constraint if exists listings_featured_rank_is_a_small_position;
alter table public.listings
  add constraint listings_featured_rank_is_a_small_position
  check (featured_rank is null or featured_rank between 1 and 99);

-- Partial: almost every row is null, and the only query is "the featured ones,
-- in order".
create index if not exists listings_featured_rank_idx
  on public.listings (featured_rank)
  where featured_rank is not null;

-- Readable by everyone who can already read the listing. No insert or update
-- grant, on purpose - see WHO CAN SET IT above.
grant select (featured_rank) on public.listings to anon, authenticated;
