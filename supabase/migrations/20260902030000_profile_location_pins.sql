-- Let a member attach real, approximate location data to the city they type.
-- The browser rounds the coordinates before writing them and these columns are
-- intentionally absent from the public marketplace projection. They are
-- available through my_profiles for future location-aware matching without
-- publishing an exact device location.

alter table public.profiles
  add column if not exists location_latitude numeric(5, 2),
  add column if not exists location_longitude numeric(5, 2);

alter table public.profiles
  drop constraint if exists profiles_location_pair_valid;

alter table public.profiles
  add constraint profiles_location_pair_valid
  check (
    (location_latitude is null and location_longitude is null)
    or (
      location_latitude is not null
      and location_longitude is not null
      and location_latitude between -90 and 90
      and location_longitude between -180 and 180
    )
  );

-- `my_profiles` was created with `select profile.*` before these columns
-- existed. Replacing it expands the owner-only projection to include the new
-- fields while keeping the existing security-barrier predicate and grants.
create or replace view public.my_profiles
with (security_barrier = true)
as
select profile.*
from public.profiles profile
where profile.auth_user_id = (select auth.uid());

comment on column public.profiles.location_latitude is
  'Approximate, city-level latitude supplied by the member. Kept out of the public marketplace projection.';

comment on column public.profiles.location_longitude is
  'Approximate, city-level longitude supplied by the member. Kept out of the public marketplace projection.';
