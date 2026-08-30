-- Consolidate the former physical-space and sponsorship-host profile roles
-- under Creator. Inventory stays differentiated on each listing: the
-- structured placement and tier columns are still the source of truth for
-- what a buyer can book.
--
-- This keeps one profile role for all supply while preserving the chosen
-- Creator offer for onboarding re-entry and profile edits.

alter table public.profiles
  add column if not exists creator_offer text;

alter table public.profiles drop constraint if exists profiles_creator_offer_valid;
alter table public.profiles
  add constraint profiles_creator_offer_valid
  check (creator_offer is null or creator_offer in ('social', 'physical', 'sponsorship'));

-- Both role constraints come off before any data moves. The pre-existing
-- profiles_extra_roles_valid already forbids `role = any(extra_roles)`, so a
-- profile carrying 'creator' as a secondary role while its primary is
-- space_owner fails the moment its primary becomes 'creator': the role UPDATE
-- below trips the OLD constraint, before the new one is ever added. This bit
-- in production - one profile was exactly that shape.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles drop constraint if exists profiles_extra_roles_valid;

-- Keep an internal record of rows whose primary role changed. The private
-- schema is not exposed through PostgREST, and this makes an accidental
-- rollout reversible without trying to infer the old role from listings.
create table if not exists private.supply_role_consolidation_backfill (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  previous_role text not null,
  moved_at timestamptz not null default now()
);

alter table private.supply_role_consolidation_backfill enable row level security;

insert into private.supply_role_consolidation_backfill (profile_id, previous_role)
select id, role
from public.profiles
where role in ('space_owner', 'sponsor_host')
on conflict (profile_id) do nothing;

-- Preserve the old role's inventory path before changing the primary role.
update public.profiles
set creator_offer = case role
  when 'space_owner' then 'physical'
  when 'sponsor_host' then 'sponsorship'
  else creator_offer
end
where role in ('space_owner', 'sponsor_host');

update public.profiles
set creator_offer = 'social'
where role = 'creator' and creator_offer is null;

update public.profiles
set role = 'creator'
where role in ('space_owner', 'sponsor_host');

-- Former role values in secondary roles still represent Creator inventory.
-- Normalize and deduplicate them before narrowing the profile constraint.
update public.profiles p
set extra_roles = (
  select coalesce(array_agg(normalized.value order by normalized.value), '{}'::text[])
  from (
    select distinct case
      when legacy.item in ('space_owner', 'sponsor_host') then 'creator'
      else legacy.item
    end as value
    from unnest(coalesce(p.extra_roles, '{}'::text[])) as legacy(item)
    where legacy.item in ('business', 'creator', 'space_owner', 'sponsor_host')
  ) normalized
  where normalized.value <> p.role
)
where p.extra_roles && array['space_owner', 'sponsor_host']::text[];

-- Catches what the normalization above does not: a secondary role that is
-- redundant once the primary says the same thing. The UPDATE above only
-- touches rows whose extra_roles still contain a legacy value, so a profile
-- that was already {'creator'} while primary-space_owner slips past it.
update public.profiles
set extra_roles = array_remove(extra_roles, role)
where role = any (extra_roles);

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('consumer', 'business', 'creator'));

alter table public.profiles
  add constraint profiles_extra_roles_valid
  check (
    extra_roles <@ array['business', 'creator']
    and not (role = any (extra_roles))
  );

-- Verification history is profile-scoped and the former supply roles now
-- verify as Creator. Normalize it before tightening that check as well.
update public.verification_requests
set verification_type = 'creator'
where verification_type in ('space_owner', 'sponsor_host');

alter table public.verification_requests
  drop constraint if exists verification_requests_verification_type_check;
alter table public.verification_requests
  add constraint verification_requests_verification_type_check
  check (verification_type in ('business', 'creator'));

comment on column public.profiles.creator_offer is
  'Creator inventory path for onboarding re-entry: social, physical placement, or sponsorship.';
