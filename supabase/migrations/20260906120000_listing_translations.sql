-- Listings in the reader's language.
--
-- The interface speaks six languages; the posts were still in whatever the
-- owner wrote. This is the cache behind translating them: one row per listing
-- and language, produced on demand by the same model that drafts listings,
-- and readable by anyone the listing itself is visible to.
--
-- Three promises:
--
-- * The original is never touched. A translation is a reading aid for someone
--   else; `listings` keeps exactly what the owner wrote, and the owner keeps
--   seeing it.
-- * A translation cannot outlive its source. `source_hash` is a digest of the
--   text it was made from. When the owner edits, the digest stops matching,
--   the row is ignored, and the next reader gets a fresh one. A stale
--   translation is worse than none: it says things the owner no longer says.
-- * Visibility follows the listing, and only the listing. The read policy asks
--   whether the caller can read the listing row; the listings policy answers
--   with its own rules (active, owner not internal, not suspended, or your
--   own). Nothing here restates them, so they cannot drift apart.
--
-- Only the service role writes: the route that calls the model runs as it. No
-- member or visitor can insert a translation, so nobody can put words in
-- someone else's listing.

create table if not exists public.listing_translations (
  listing_id uuid not null references public.listings (id) on delete cascade,
  locale text not null,
  source_hash text not null,
  fields jsonb not null default '{}'::jsonb,
  translated_at timestamptz not null default now(),
  primary key (listing_id, locale),
  constraint listing_translations_locale_is_a_language_tag
    check (locale <> 'en' and locale ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$'),
  constraint listing_translations_fields_are_an_object
    check (jsonb_typeof(fields) = 'object'),
  constraint listing_translations_source_hash_is_sha256
    check (source_hash ~ '^[0-9a-f]{64}$')
);

comment on table public.listing_translations is
  'Machine translations of listing copy, one row per listing and language. A cache: the original stays in listings, and a row whose source_hash no longer matches the listing text is stale and gets replaced. Readable by whoever can read the listing; written only by the service role.';

alter table public.listing_translations enable row level security;

revoke all on table public.listing_translations from public, anon, authenticated;
grant select on table public.listing_translations to anon, authenticated;
grant all on table public.listing_translations to service_role;

drop policy if exists "Translations follow the listing" on public.listing_translations;
create policy "Translations follow the listing" on public.listing_translations
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.listings listing
      where listing.id = listing_translations.listing_id
    )
  );
