-- What a physical space listing has to say for itself.
--
-- The space owner flow shipped asking four things - kind, address, foot
-- traffic, availability - and then DREW A CONCLUSION the owner never gave it.
-- Every space owner's drafted description carried the sentence
--
--     "It suits a poster, a decal, or a printed card, and I can help put it up."
--
-- verbatim. A landlord who does not allow adhesive on glass was publishing an
-- offer of decals, and every owner was volunteering their own labour. The three
-- columns here are the questions that sentence was standing in for, so the
-- description can be composed from answers instead of assumptions.
--
-- Additive only. Every column is nullable or defaulted, so existing rows are
-- unaffected and the currently-deployed client keeps working - it selects
-- listings with `*` and simply will not write these.

alter table public.listings
  add column if not exists surface_types text[] not null default '{}',
  add column if not exists install_by text,
  add column if not exists space_size text not null default '';

-- Who physically puts the artwork up. Three values because "either" is a real
-- answer and the commonest one, not a missing answer.
alter table public.listings drop constraint if exists listings_install_by_valid;
alter table public.listings
  add constraint listings_install_by_valid
  check (install_by is null or install_by in ('owner', 'renter', 'either'));

alter table public.listings drop constraint if exists listings_space_size_len;
alter table public.listings
  add constraint listings_space_size_len
  check (char_length(space_size) <= 80);

comment on column public.listings.surface_types is
  'What can physically go up in this space - poster, vinyl decal, counter '
  'cards, banner, A-frame, mural, screen. Owner-answered. Replaces the '
  'hardcoded "suits a poster, a decal, or a printed card" the drafted '
  'description used to assert on every space owner''s behalf.';
comment on column public.listings.install_by is
  'owner = the space owner puts it up, renter = the buyer installs it, '
  'either = both work. Null for a listing that predates the question.';
comment on column public.listings.space_size is
  'Free text, roughly "6 ft x 3 ft". The description helper has always told '
  'space owners to add the size by hand; this is the form finally asking.';
