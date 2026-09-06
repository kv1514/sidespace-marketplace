begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- Who may read and who may write. Visitors and members read; only the route,
-- as the service role, writes. Nobody can put words in someone else's listing.
select ok(
  has_table_privilege('anon', 'public.listing_translations', 'select'),
  'visitors can read listing translations'
);
select ok(
  not has_table_privilege('anon', 'public.listing_translations', 'insert'),
  'visitors cannot write listing translations'
);
select ok(
  has_table_privilege('authenticated', 'public.listing_translations', 'select'),
  'members can read listing translations'
);
select ok(
  not has_table_privilege('authenticated', 'public.listing_translations', 'insert'),
  'members cannot write listing translations'
);
select ok(
  not has_table_privilege('authenticated', 'public.listing_translations', 'update'),
  'members cannot change listing translations'
);
select ok(
  not has_table_privilege('authenticated', 'public.listing_translations', 'delete'),
  'members cannot remove listing translations'
);
select ok(
  has_table_privilege('service_role', 'public.listing_translations', 'insert'),
  'the service role writes listing translations'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class
   where oid = 'public.listing_translations'::regclass),
  'row level security is on for listing translations'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('a1000000-0000-4000-8000-000000000011', 'authenticated', 'authenticated',
   'translations-owner@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('a1000000-0000-4000-8000-000000000012', 'authenticated', 'authenticated',
   'translations-suspended@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('a1000000-0000-4000-8000-000000000013', 'authenticated', 'authenticated',
   'translations-reader@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, is_demo, onboarding_complete, suspended_at
)
values
  ('a2000000-0000-4000-8000-000000000011',
   'a1000000-0000-4000-8000-000000000011', 'creator', 'Translations Owner', false, true, null),
  ('a2000000-0000-4000-8000-000000000012',
   'a1000000-0000-4000-8000-000000000012', 'creator', 'Translations Suspended', false, true, now()),
  ('a2000000-0000-4000-8000-000000000013',
   'a1000000-0000-4000-8000-000000000013', 'business', 'Translations Reader', false, true, null);

alter table public.listings disable trigger listings_enforce_provenance;
insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description,
  status, provenance_status, availability_confirmed_at
)
values
  ('a3000000-0000-4000-8000-000000000011',
   'a2000000-0000-4000-8000-000000000011',
   'A live listing', 'Instagram', 'One post', 10000,
   'Public, so its translation is public too.',
   'active', 'owner_attested', now()),
  ('a3000000-0000-4000-8000-000000000012',
   'a2000000-0000-4000-8000-000000000011',
   'A paused listing', 'Instagram', 'One post', 10000,
   'Hidden from everyone but its owner, and so is its translation.',
   'paused', 'owner_attested', now()),
  ('a3000000-0000-4000-8000-000000000013',
   'a2000000-0000-4000-8000-000000000012',
   'A suspended member''s listing', 'Instagram', 'One post', 10000,
   'Active, but its owner is suspended, so nobody sees it.',
   'active', 'owner_attested', now());
alter table public.listings enable trigger listings_enforce_provenance;

-- The service role writes translations, within the table's own rules.
select lives_ok(
  $$insert into public.listing_translations (listing_id, locale, source_hash, fields)
    values
      ('a3000000-0000-4000-8000-000000000011', 'es', repeat('a', 64),
       '{"title":"Un anuncio activo"}'::jsonb),
      ('a3000000-0000-4000-8000-000000000012', 'es', repeat('b', 64),
       '{"title":"Un anuncio pausado"}'::jsonb),
      ('a3000000-0000-4000-8000-000000000013', 'es', repeat('c', 64),
       '{"title":"El anuncio de un miembro suspendido"}'::jsonb)$$,
  'the service role can cache a translation per listing and language'
);
select throws_ok(
  $$insert into public.listing_translations (listing_id, locale, source_hash, fields)
    values ('a3000000-0000-4000-8000-000000000011', 'en', repeat('a', 64), '{}'::jsonb)$$,
  '23514',
  null,
  'English is the original, never a translation'
);
select throws_ok(
  $$insert into public.listing_translations (listing_id, locale, source_hash, fields)
    values ('a3000000-0000-4000-8000-000000000011', 'fr', 'not a digest', '{}'::jsonb)$$,
  '23514',
  null,
  'a translation must name the digest of the text it was made from'
);
select throws_ok(
  $$insert into public.listing_translations (listing_id, locale, source_hash, fields)
    values ('a3000000-0000-4000-8000-000000000011', 'fr', repeat('a', 64), '["title"]'::jsonb)$$,
  '23514',
  null,
  'translated fields are an object, field by field'
);
select throws_ok(
  $$insert into public.listing_translations (listing_id, locale, source_hash, fields)
    values ('a3000000-0000-4000-8000-000000000011', 'es', repeat('d', 64), '{}'::jsonb)$$,
  '23505',
  null,
  'one translation per listing and language; a newer one replaces it'
);

-- A member who owns none of these sees exactly the translations of the
-- listings they can see: the live one, and not the paused or the suspended
-- member's. The listings policy decides; this table only follows it.
select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000013","role":"authenticated"}',
  true
);
set local role authenticated;

select results_eq(
  $$select listing_id::text from public.listing_translations
    where listing_id in (
      'a3000000-0000-4000-8000-000000000011',
      'a3000000-0000-4000-8000-000000000012',
      'a3000000-0000-4000-8000-000000000013'
    ) order by listing_id$$,
  $$values ('a3000000-0000-4000-8000-000000000011')$$,
  'a member reads the translation of a public listing and nothing hidden'
);
select throws_ok(
  $$insert into public.listing_translations (listing_id, locale, source_hash, fields)
    values ('a3000000-0000-4000-8000-000000000011', 'fr', repeat('e', 64), '{"title":"x"}'::jsonb)$$,
  '42501',
  null,
  'a member cannot write a translation'
);
select throws_ok(
  $$update public.listing_translations set fields = '{"title":"changed"}'::jsonb
    where listing_id = 'a3000000-0000-4000-8000-000000000011'$$,
  '42501',
  null,
  'a member cannot change a translation'
);

reset role;

-- The owner sees their paused listing, so they see its translation too.
select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000011","role":"authenticated"}',
  true
);
set local role authenticated;

select results_eq(
  $$select listing_id::text from public.listing_translations
    where listing_id in (
      'a3000000-0000-4000-8000-000000000011',
      'a3000000-0000-4000-8000-000000000012',
      'a3000000-0000-4000-8000-000000000013'
    ) order by listing_id$$,
  $$values ('a3000000-0000-4000-8000-000000000011'),
           ('a3000000-0000-4000-8000-000000000012')$$,
  'an owner reads the translations of their own listings, live or paused, and no one else''s hidden ones'
);

reset role;

-- Deleting the listing takes its translations with it.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
delete from public.listings where id = 'a3000000-0000-4000-8000-000000000011';
select is(
  (select count(*) from public.listing_translations
   where listing_id = 'a3000000-0000-4000-8000-000000000011'),
  0::bigint,
  'a translation does not outlive its listing'
);

select * from finish();
rollback;
