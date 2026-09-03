-- "View whole street": an interactive 360 panorama next to the Street View
-- card. Google's Maps Embed API and Maps URLs both open a panorama by id, and
-- the Street View Static API policy names the panorama id as the one value
-- that may be stored indefinitely. So the listing keeps it, next to the
-- capture month from 20260903073000. Public like the month: the card and its
-- button render wherever the listing does, and the owner chose to attach it.
alter table public.listings
  add column if not exists street_view_pano text not null default '';

alter table public.listings drop constraint if exists listings_street_view_pano_len;
alter table public.listings
  add constraint listings_street_view_pano_len
  check (char_length(street_view_pano) <= 120);

comment on column public.listings.street_view_pano is
  'Google Street View panorama id at the exact address, the one Street View value Google lets us keep. Opens the interactive 360 view. Empty when no Street View is attached.';

grant select (street_view_pano) on public.listings to anon, authenticated;

create or replace view public.my_listings
with (security_invoker = true, security_barrier = true) as
select
  id, owner_profile_id, title, channel, format, price_cents, price_unit,
  description, demographics, image_url, status, created_at, updated_at,
  image_urls, location_area, availability_notes, available_from, available_to,
  lead_time_days, minimum_booking, deliverables, cancellation_policy,
  price_max_cents, brief_scope, target_platforms, street_address,
  surface_types, install_by, space_size, sponsor_tier, sponsor_slots,
  provenance_status, availability_confirmed_at, instant_booking_enabled,
  availability_dates, booking_duration_days, booking_timezone,
  street_view_captured, street_view_pano
from private.current_user_listing_rows() listing(
  id, owner_profile_id, title, channel, format, price_cents, price_unit,
  description, demographics, image_url, status, created_at, updated_at,
  image_urls, location_area, availability_notes, available_from, available_to,
  lead_time_days, minimum_booking, deliverables, cancellation_policy,
  price_max_cents, brief_scope, target_platforms, street_address,
  surface_types, install_by, space_size, sponsor_tier, sponsor_slots,
  provenance_status, availability_confirmed_at, instant_booking_enabled,
  availability_dates, booking_duration_days, booking_timezone,
  street_view_captured, street_view_pano
);
