-- Sponsorship is tiered. The listing table could not say so.
--
-- The onboarding section was headed "Name the package and set the tier" and
-- then asked for ONE number and ONE flat list of benefits, so a team either
-- underpriced a jersey logo or overpriced a website mention. Bronze/Silver/Gold
-- is not a nicety in this category - it is the shape of the product.
--
-- A sponsorship host now publishes one listing PER TIER. These two columns are
-- what make three rows from one team legible as three levels of one offer
-- rather than three unrelated listings.
--
-- Additive only. Both columns are nullable, existing rows are untouched, and
-- listings are selected with `*`, so the deployed client keeps working - it
-- simply will not write them.

alter table public.listings
  add column if not exists sponsor_tier text,
  add column if not exists sponsor_slots integer;

alter table public.listings drop constraint if exists listings_sponsor_tier_len;
alter table public.listings
  add constraint listings_sponsor_tier_len
  check (sponsor_tier is null or char_length(trim(sponsor_tier)) between 1 and 40);

-- A tier with zero spots is not on offer, and a tier with a million is not a
-- tier. The ceiling is loose on purpose; the point is to reject nonsense.
alter table public.listings drop constraint if exists listings_sponsor_slots_valid;
alter table public.listings
  add constraint listings_sponsor_slots_valid
  check (sponsor_slots is null or sponsor_slots between 1 and 10000);

comment on column public.listings.sponsor_tier is
  'The tier name a sponsorship host gave this level - Gold, Silver, Founding '
  'Partner. Null for every listing that is not a sponsorship. Sibling tiers '
  'from one team share owner_profile_id and channel = Sponsorship.';
comment on column public.listings.sponsor_slots is
  'How many sponsors this tier has room for. Null means unstated, which is '
  'different from none - nothing decrements this yet.';
