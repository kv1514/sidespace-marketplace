-- Keep the browser-facing owner projections as SECURITY INVOKER views without
-- granting private base-table columns to every authenticated member.
--
-- The small SECURITY DEFINER helpers live in the non-exposed `private` schema,
-- have a fixed search path, and return only rows owned by auth.uid(). The public
-- views themselves now run with the caller's privileges, so they no longer
-- inherit the view creator's broad table privileges.

create or replace function private.current_user_profile_rows()
returns setof public.profiles
language sql
stable
security definer
set search_path = ''
as $$
  select profile.*
  from public.profiles profile
  where profile.auth_user_id = (select auth.uid());
$$;

create or replace function private.current_user_listing_rows()
returns setof public.listings
language sql
stable
security definer
set search_path = ''
as $$
  select listing.*
  from public.listings listing
  where exists (
    select 1
    from public.profiles profile
    where profile.id = listing.owner_profile_id
      and profile.auth_user_id = (select auth.uid())
  );
$$;

revoke all on function private.current_user_profile_rows()
  from public, anon, authenticated, service_role;
revoke all on function private.current_user_listing_rows()
  from public, anon, authenticated, service_role;
grant execute on function private.current_user_profile_rows()
  to authenticated;
grant execute on function private.current_user_listing_rows()
  to authenticated;

create or replace view public.my_profiles
with (security_invoker = true, security_barrier = true)
as
select
  profile.id,
  profile.auth_user_id,
  profile.role,
  profile.display_name,
  profile.handle,
  profile.bio,
  profile.city,
  profile.categories,
  profile.followers,
  profile.avg_views,
  profile.audience_age,
  profile.website,
  profile.avatar_url,
  profile.verified,
  profile.is_demo,
  profile.onboarding_complete,
  profile.created_at,
  profile.updated_at,
  profile.social_links,
  profile.gallery_urls,
  profile.verification_status,
  profile.social_verification,
  profile.extra_roles,
  profile.is_internal,
  profile.reach_unit,
  profile.creator_offer,
  profile.creator_offers,
  profile.location_latitude,
  profile.location_longitude
from private.current_user_profile_rows() profile;

create or replace view public.my_listings
with (security_invoker = true, security_barrier = true)
as
select
  listing.id,
  listing.owner_profile_id,
  listing.title,
  listing.channel,
  listing.format,
  listing.price_cents,
  listing.price_unit,
  listing.description,
  listing.demographics,
  listing.image_url,
  listing.status,
  listing.created_at,
  listing.updated_at,
  listing.image_urls,
  listing.location_area,
  listing.availability_notes,
  listing.available_from,
  listing.available_to,
  listing.lead_time_days,
  listing.minimum_booking,
  listing.deliverables,
  listing.cancellation_policy,
  listing.price_max_cents,
  listing.brief_scope,
  listing.target_platforms,
  listing.street_address,
  listing.surface_types,
  listing.install_by,
  listing.space_size,
  listing.sponsor_tier,
  listing.sponsor_slots,
  listing.provenance_status,
  listing.availability_confirmed_at,
  listing.instant_booking_enabled,
  listing.availability_dates,
  listing.booking_duration_days,
  listing.booking_timezone
from private.current_user_listing_rows() listing;

revoke all on table public.my_profiles, public.my_listings
  from public, anon, authenticated;
grant select on table public.my_profiles, public.my_listings
  to authenticated;

comment on function private.current_user_profile_rows() is
  'Non-exposed owner boundary for the security-invoker my_profiles API view.';
comment on function private.current_user_listing_rows() is
  'Non-exposed owner boundary for the security-invoker my_listings API view.';
comment on view public.my_profiles is
  'Security-invoker owner profile projection backed by a non-exposed, auth.uid-scoped helper.';
comment on view public.my_listings is
  'Security-invoker owner listing projection backed by a non-exposed, auth.uid-scoped helper.';
