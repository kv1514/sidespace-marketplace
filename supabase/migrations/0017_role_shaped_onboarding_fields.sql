-- Fields the role-shaped onboarding actually asks for.
--
-- The first pass at the two-step onboarding collapsed several questions that
-- were asked for by name: a business could not say whether it wanted physical
-- or virtual space, could not give a budget RANGE, could not name the social
-- platforms it wanted to target, and could not upload the flyer it needs
-- carried. Creators and space owners were asked for an @handle when what the
-- other party actually needs is an email, and a space owner could only give a
-- city when the whole point of a physical listing is where it is.
--
-- Additive only. Every column is nullable or defaulted, so existing rows are
-- unaffected and the currently-deployed client keeps working: it selects an
-- explicit column list and simply will not ask for these.

-- ---------------------------------------------------------------------------
-- 1. profiles: who to talk to
--
--    `handle` stays on the table (it is uniquely indexed and legacy rows use
--    it), but onboarding no longer asks for it. A business is identified by
--    its business name, and a creator or space owner by an email.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists contact_name text not null default '',
  add column if not exists contact_email text not null default '';

alter table public.profiles drop constraint if exists profiles_contact_email_shape;
alter table public.profiles
  add constraint profiles_contact_email_shape
  check (contact_email = '' or contact_email like '%_@_%.__%');

comment on column public.profiles.contact_name is
  'The human behind a business account. display_name stays the public/business '
  'identity that renders on cards; this is who a booker is actually writing to.';
comment on column public.profiles.contact_email is
  'Reply-to address collected during onboarding, replacing the @handle question '
  'for creators and space owners.';

-- ---------------------------------------------------------------------------
-- 2. listings: what a business brief actually specifies
--
--    price stays the LOW end of the range so every existing reader keeps
--    working unchanged (cards, sorting, campaign requests all read `price`).
--    price_max is the optional high end.
-- ---------------------------------------------------------------------------
alter table public.listings
  add column if not exists price_max integer,
  add column if not exists brief_scope text,
  add column if not exists target_platforms text[] not null default '{}',
  add column if not exists street_address text not null default '';

alter table public.listings drop constraint if exists listings_price_max_valid;
alter table public.listings
  add constraint listings_price_max_valid
  check (price_max is null or price_max >= price);

alter table public.listings drop constraint if exists listings_brief_scope_valid;
alter table public.listings
  add constraint listings_brief_scope_valid
  check (brief_scope is null or brief_scope in ('physical', 'virtual', 'both'));

alter table public.listings drop constraint if exists listings_street_address_len;
alter table public.listings
  add constraint listings_street_address_len
  check (char_length(street_address) <= 240);

comment on column public.listings.price_max is
  'Upper end of a budget range. price remains the lower end so every existing '
  'reader - cards, ordering, campaign_requests - keeps working untouched.';
comment on column public.listings.brief_scope is
  'For a Business brief: whether they want physical space, virtual placements, '
  'or both. Drives which half of the brief form renders.';
comment on column public.listings.target_platforms is
  'Social platforms a business brief wants to target. Empty for a purely '
  'physical brief, which is the point - that brief never asks the question.';
comment on column public.listings.street_address is
  'Exact address of a physical space, supplied by the owner so a booker can '
  'actually find it and preview the block. Owner-entered per listing, never '
  'derived from a profile.';
