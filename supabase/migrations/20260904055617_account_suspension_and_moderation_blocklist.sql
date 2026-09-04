-- Moderation: suspend an account, and block a banned brand from reappearing.
--
-- Until now the only lever for taking a member down was flipping
-- onboarding_complete off, which is a repurposed signup flag: it hides them,
-- but it also drops them back into onboarding if they sign in, and it is
-- indistinguishable from a member who genuinely never finished. This adds a
-- real one.
--
-- is_internal was NOT reused. It already hides a profile and blocks listing
-- creation, but it means "a SideSpace staff/test account" and is read that way
-- by preview/page.tsx and the person cards. Mixing banned members into it would
-- make both meanings unreadable.

alter table public.profiles
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_reason text;

comment on column public.profiles.suspended_at is
  'Set when a member is suspended by staff. Hides their profile and listings from the public, and blocks new listings. Null = in good standing.';

create or replace function private.profile_is_suspended(target_profile_id uuid)
returns boolean language sql stable security definer set search_path to ''
as $$
  select coalesce((
    select profile.suspended_at is not null
    from public.profiles profile
    where profile.id = target_profile_id
  ), false);
$$;

-- A suspended profile leaves the public directory. Own-row access is kept so
-- the member can still see their account rather than hitting a blank app.
drop policy if exists "Profiles are publicly readable" on public.profiles;
create policy "Profiles are publicly readable" on public.profiles for select
using (
  (onboarding_complete and not private.profile_is_internal(id) and suspended_at is null)
  or private.profile_owned_by_current_user(id)
);

-- Their listings go with them, whatever status the rows carry. This keeps the
-- helper-function shape from 20260901080846 rather than reintroducing the
-- profiles subquery that migration deliberately removed.
drop policy if exists "Active listings are public" on public.listings;
create policy "Active listings are public" on public.listings for select
using (
  (status = 'active'
    and not private.profile_is_internal(owner_profile_id)
    and not private.profile_is_suspended(owner_profile_id))
  or private.profile_owned_by_current_user(owner_profile_id)
);

-- And they cannot post again. This is the "ban future posts" half.
drop policy if exists "Members create their own listings" on public.listings;
create policy "Members create their own listings" on public.listings for insert
with check (
  private.profile_owned_by_current_user(owner_profile_id)
  and not private.profile_is_internal(owner_profile_id)
  and not private.profile_is_suspended(owner_profile_id)
  and exists (
    select 1 from public.profiles profile
    where profile.id = listings.owner_profile_id
      and profile.onboarding_complete
      and profile.role <> 'consumer'
  )
);

-- Content-level ban, so the brand cannot return under a new account.
--
-- PATTERNS ARE REGEX AND MUST BE NARROW. A bare 'jerk' would block a beef
-- jerky stand and a Jamaican jerk chicken window - both exactly the kind of
-- small business this marketplace exists for. The RPC added in
-- 20260904060549 refuses any pattern that would hit a listing from a member in
-- good standing, which is what keeps that from happening by accident.
create table if not exists public.moderation_blocklist (
  id bigint generated always as identity primary key,
  pattern text not null unique,
  reason text not null,
  created_at timestamptz not null default now()
);

alter table public.moderation_blocklist enable row level security;
revoke all on public.moderation_blocklist from public, anon, authenticated;
grant all on public.moderation_blocklist to service_role;

comment on table public.moderation_blocklist is
  'Case-insensitive regex patterns rejected from listing titles and descriptions. Keep patterns narrow; a broad one silently blocks legitimate businesses.';

create or replace function private.reject_blocklisted_listing()
returns trigger language plpgsql security definer set search_path to ''
as $$
declare hit text;
begin
  select b.pattern into hit
  from public.moderation_blocklist b
  where coalesce(new.title, '') || ' ' || coalesce(new.description, '') ~* b.pattern
  limit 1;

  if hit is not null then
    raise exception 'This listing cannot be published.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists listings_reject_blocklisted on public.listings;
create trigger listings_reject_blocklisted
before insert or update of title, description on public.listings
for each row execute function private.reject_blocklisted_listing();

-- The first ban, applied with the schema so the repo matches the database.
-- Both statements are no-ops on a database that does not contain this member.
insert into public.moderation_blocklist (pattern, reason)
values ('jerk[[:space:]_-]*space', 'Banned brand: Jerkspace')
on conflict (pattern) do nothing;

update public.profiles
set suspended_at = coalesce(suspended_at, now()),
    suspended_reason = 'Obscene listing content',
    onboarding_complete = true
where id = '79d4bdbc-8d5b-4b39-9764-10dec95914cf';
