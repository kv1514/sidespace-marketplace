-- Take the private fields out of the world-readable profiles row.
--
-- `anon` holds a table-level SELECT grant on public.profiles, so a logged-out
-- caller with the publishable key that ships in our JavaScript can read EVERY
-- column of every onboarded profile in one request:
--
--   curl "$SUPABASE_URL/rest/v1/profiles?select=*" -H "apikey: <publishable>"
--
-- The app itself is careful - lib/supabase/public.ts selects through
-- PUBLIC_PROFILE_COLUMNS - but that allowlist only narrows OUR queries. It does
-- nothing about someone querying PostgREST directly.
--
-- WHY NOT A COLUMN GRANT, AND WHY NOT A VIEW
--
-- Both were tried. 0013 revoked the table grant and granted back the public
-- columns; 0014 reverted it because `anon` needs TABLE-level SELECT on profiles
-- for the listings -> profiles embed the homepage depends on. It broke
-- production twice, silently: the query errored, page.tsx fell through to
-- nulls, and the marketplace served invented demo businesses.
--
-- 0014 suggested a view instead. That was measured here and does NOT work
-- either. A definer view over profiles is readable standalone as `anon`, but
-- every correlated shape - plain join, EXISTS, and the LEFT JOIN LATERAL that
-- PostgREST actually generates for an embedded resource - still fails with
-- `permission denied for table profiles` once the base grant is gone. Verified
-- six ways inside a rolled-back transaction before writing this.
--
-- So the grant has to stay, which means the row itself must stop carrying
-- anything private. That is what this migration does. Every join, embed and
-- homepage query keeps working untouched, because profiles keeps its grant.
--
-- STAGING. The columns are NOT dropped here. Production is still running code
-- that writes them, and dropping them out from under it would break onboarding
-- immediately. They are emptied and commented instead; the drop is a follow-up
-- once the deploy that stops writing them has landed.

create table if not exists public.profile_contacts (
  profile_id uuid primary key
    references public.profiles(id) on delete cascade,
  contact_email text,
  contact_name text,
  business_preferences jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profile_contacts enable row level security;

-- anon gets nothing at all: this table is the reason the migration exists.
revoke all on public.profile_contacts from public, anon;
grant select, insert, update on public.profile_contacts to authenticated;
grant all on public.profile_contacts to service_role;

-- A signed-in member reaches exactly one row: their own.
drop policy if exists "Members read their own contact details" on public.profile_contacts;
create policy "Members read their own contact details"
  on public.profile_contacts for select
  using (exists (
    select 1 from public.profiles p
    where p.id = profile_contacts.profile_id
      and p.auth_user_id = (select auth.uid())
  ));

drop policy if exists "Members write their own contact details" on public.profile_contacts;
create policy "Members write their own contact details"
  on public.profile_contacts for insert
  with check (exists (
    select 1 from public.profiles p
    where p.id = profile_contacts.profile_id
      and p.auth_user_id = (select auth.uid())
  ));

drop policy if exists "Members update their own contact details" on public.profile_contacts;
create policy "Members update their own contact details"
  on public.profile_contacts for update
  using (exists (
    select 1 from public.profiles p
    where p.id = profile_contacts.profile_id
      and p.auth_user_id = (select auth.uid())
  ));

-- Carry the existing values across before emptying the public copy.
insert into public.profile_contacts (profile_id, contact_email, contact_name, business_preferences)
select id, nullif(trim(contact_email), ''), nullif(trim(contact_name), ''), business_preferences
from public.profiles
where nullif(trim(contact_email), '') is not null
   or nullif(trim(contact_name), '') is not null
   or business_preferences is not null
on conflict (profile_id) do update
set contact_email        = coalesce(excluded.contact_email, public.profile_contacts.contact_email),
    contact_name         = coalesce(excluded.contact_name, public.profile_contacts.contact_name),
    business_preferences = coalesce(excluded.business_preferences, public.profile_contacts.business_preferences),
    updated_at           = now();

-- The public copy is now redundant. Empty it: this is what closes the leak.
--
-- contact_email and contact_name are NOT NULL DEFAULT '', so they are emptied
-- to '' rather than nulled. That keeps the constraint - and the currently
-- deployed code, which still writes them - working untouched until the drop.
update public.profiles
set contact_email = '', contact_name = '', business_preferences = null
where contact_email <> ''
   or contact_name <> ''
   or business_preferences is not null;

comment on column public.profiles.contact_email is
  'DEAD - moved to profile_contacts. profiles is world-readable by anon; never write private data here.';
comment on column public.profiles.contact_name is
  'DEAD - moved to profile_contacts. profiles is world-readable by anon; never write private data here.';
comment on column public.profiles.business_preferences is
  'DEAD - moved to profile_contacts. profiles is world-readable by anon; never write private data here.';
comment on table public.profile_contacts is
  'Private per-member fields kept out of the world-readable profiles row.';
