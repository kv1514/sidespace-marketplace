-- Support columns and integrity guards for the two-step onboarding.
--
-- Additive only. Nothing here narrows a CHECK, drops a column, or touches an
-- RLS policy. Re-applying is a no-op.
--
-- Prerequisite: 0015_add_sponsor_host_role.sql. That is the migration that adds
-- `sponsor_host` to profiles_role_check and profiles_extra_roles_valid, drops
-- profiles_pause_listings_on_consumer, and backfills consumer -> business.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   * No role CHECK change. 0015 widened it and left 'consumer' legal, and
--     'consumer' stays legal permanently: three policies (0009:118-124,
--     0009:192, 0011:91-101) name the literal, and dropping a value from a
--     CHECK re-validates every row to buy nothing. sponsor_host <> 'consumer'
--     is already true, so a sponsorship host satisfies the listings INSERT
--     gate, the publish-active gate and the verification gate the moment 0015
--     lands. That is why this migration changes no policy.
--
--   * No CHECK on listings.channel. The 0002 seeds carry 'Cafe window',
--     'Counter card', 'Bakery window', 'Main Street' and 'Farm stand'. A CHECK
--     would reject live rows -- and free-text channel is exactly what lets the
--     new 'Sponsorship' value ship with no migration at all, because the
--     marketplace's channel chips are derived from live listings
--     (MarketplaceApp.tsx:1655-1671), so it gets its own filter for free.
--
--   * No CHECK on listings.price_unit. Two seeded rows carry values outside any
--     plausible list: 'story set' and 'run', both from 0002. NOT VALID would
--     not save us -- it skips the initial scan but the constraint is still
--     enforced on every later INSERT and UPDATE, so pausing either row would
--     throw.
--
--   * No listing_locations table. Onboarding does not collect a street address:
--     nothing in the product reads coordinates, there is no map and no
--     proximity search, so the highest-friction question in the flow would buy
--     nothing. Add the table when something actually reads it.

-- ---------------------------------------------------------------------------
-- 1. profiles.reach_unit
--
--    avg_views is one column carrying two incompatible meanings. The person
--    card renders it as
--        {person.followers ? " followers" : " weekly looks"}
--    (MarketplaceApp.tsx:4498-4499), so a barbershop's daily footfall and a
--    robotics team's season crowd both publish as "weekly looks", which is
--    false. Onboarding's own label did the same thing in the other direction:
--    "Average views / weekly looks" on a single input.
--
--    One additive, defaulted text column fixes it with no data migration. Every
--    existing row keeps rendering exactly as it does today, because the default
--    IS the string the card currently hardcodes.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists reach_unit text not null default 'weekly looks';

alter table public.profiles drop constraint if exists profiles_reach_unit_valid;
alter table public.profiles
  add constraint profiles_reach_unit_valid
  check (reach_unit in (
    'weekly looks',
    'people a day',
    'people a season',
    'people per event'
  ));

comment on column public.profiles.reach_unit is
  'Unit for avg_views on the person card. Set by onboarding from a role-shaped '
  'chip: creators keep the default, space owners get people a day, sponsorship '
  'hosts get people a season or people per event.';

-- ---------------------------------------------------------------------------
-- 2. verification_requests.verification_type must know about sponsor_host
--
--    THIS IS THE ONE CHANGE HERE WITHOUT WHICH THE RELEASE IS BROKEN.
--
--    The client inserts `verification_type: profile.role` (MarketplaceApp.tsx,
--    submitVerificationRequest) and the verification modal is gated only on
--    `profile.role !== 'consumer'`. The CHECK on this column still lists three
--    roles, so the moment a sponsorship host requests verification Postgres
--    raises 23514 and the member gets a generic "something went wrong".
--
--    TypeScript could not catch this: the supabase client is untyped here, so
--    a widened Role union flows into the insert unchecked.
-- ---------------------------------------------------------------------------
alter table public.verification_requests
  drop constraint if exists verification_requests_verification_type_check;
alter table public.verification_requests
  add constraint verification_requests_verification_type_check
  check (verification_type in (
    'business',
    'creator',
    'space_owner',
    'sponsor_host'
  ));

-- ---------------------------------------------------------------------------
-- 3. listings.title -- reject whitespace-only titles
--
--    0010 in this repo reads `char_length(title) between 1 and 120`, which a
--    single space satisfies. Production, however, already carries the TRIMMED
--    form under the same constraint name -- it was patched by hand at some
--    point and the repo never caught up.
--
--    So this redefines listings_title_length itself rather than adding a second
--    constraint beside it: on production it is a no-op that reconciles the
--    migration history with what is actually there, and on a database built
--    from these files it closes the whitespace hole for real.
-- ---------------------------------------------------------------------------
alter table public.listings drop constraint if exists listings_title_length;
alter table public.listings
  add constraint listings_title_length
  check (char_length(trim(title)) between 1 and 120);

-- ---------------------------------------------------------------------------
-- 4. listings availability window ordering
--
--    campaign_requests has had campaign_dates_in_order since 0005. listings
--    never got the equivalent; it is checked only in the client at
--    MarketplaceApp.tsx:2390-2396. The business branch of onboarding now writes
--    both dates from a chip, so the guard should be real.
-- ---------------------------------------------------------------------------
alter table public.listings drop constraint if exists listings_dates_in_order;
alter table public.listings
  add constraint listings_dates_in_order
  check (
    available_from is null
    or available_to is null
    or available_to >= available_from
  ) not valid;

do $$
declare
  bad_count integer;
begin
  select count(*) into bad_count
  from public.listings
  where available_from is not null
    and available_to is not null
    and available_to < available_from;

  if bad_count = 0 then
    alter table public.listings validate constraint listings_dates_in_order;
  else
    raise notice
      'listings_dates_in_order left NOT VALID: % existing row(s) end before they '
      'start. New and updated rows are already guarded.',
      bad_count;
  end if;
end;
$$;
