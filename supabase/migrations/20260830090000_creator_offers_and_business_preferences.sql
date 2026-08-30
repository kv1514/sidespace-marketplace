-- Keep the Creator's three inventory paths together on one profile while
-- storing the brief signals a Business uses to tune its dashboard shortlist.
alter table public.profiles
  add column if not exists creator_offers text[] not null default '{}'::text[],
  add column if not exists business_preferences jsonb;

-- Existing Creator rows have the old singular field. Preserve it as the
-- initial selection; new writes keep both columns in sync for compatibility
-- with older clients and legacy rows.
update public.profiles
set creator_offers = array[creator_offer]
where coalesce(cardinality(creator_offers), 0) = 0
  and creator_offer in ('social', 'physical', 'sponsorship');

alter table public.profiles
  drop constraint if exists profiles_creator_offers_valid;

alter table public.profiles
  add constraint profiles_creator_offers_valid
  check (
    creator_offers <@ array['social', 'physical', 'sponsorship']::text[]
  );

alter table public.profiles
  drop constraint if exists profiles_business_preferences_object;

alter table public.profiles
  add constraint profiles_business_preferences_object
  check (
    business_preferences is null
    or jsonb_typeof(business_preferences) = 'object'
  );

comment on column public.profiles.creator_offers is
  'Creator inventory paths selected for publishing: social, physical, sponsorship.';

comment on column public.profiles.business_preferences is
  'Business campaign signals used to rank creator recommendations.';
