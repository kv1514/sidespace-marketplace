-- Street View, the way Google's terms allow it.
--
-- The first version of "Add a Google Street View photo" downloaded the frame
-- and uploaded it as a listing photo. The Maps Platform terms forbid exactly
-- that: Google Maps Content may not be stored, cached, re-shared, or
-- re-hosted, and the Street View Static API policy names only the panorama id
-- as storable. So the frame is no longer kept anywhere. The listing page
-- fetches it from Google on every view through a pass-through route, and the
-- listing row keeps one small value: the month Google captured the frame,
-- which is the card's caption and its on/off switch.
--
-- Visibility: the month is public, since the card shows wherever the listing
-- does. It joins the anon and authenticated column grants (0020 revoked the
-- table-wide SELECT, so a new column is invisible until granted), and the
-- owner's my_listings projection, which names its columns and so must be
-- re-created to carry it. The owner writes it through the ordinary listing
-- update; authenticated already holds a table-level UPDATE grant.
alter table public.listings
  add column if not exists street_view_captured text not null default '';

alter table public.listings drop constraint if exists listings_street_view_captured_len;
alter table public.listings
  add constraint listings_street_view_captured_len
  check (char_length(street_view_captured) <= 40);

comment on column public.listings.street_view_captured is
  'Month Google captured the Street View frame of the exact address, as shown under the card ("March 2025"). Empty when no Street View is attached. The frame itself is never stored.';

grant select (street_view_captured) on public.listings to anon, authenticated;

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
  street_view_captured
from private.current_user_listing_rows() listing(
  id, owner_profile_id, title, channel, format, price_cents, price_unit,
  description, demographics, image_url, status, created_at, updated_at,
  image_urls, location_area, availability_notes, available_from, available_to,
  lead_time_days, minimum_booking, deliverables, cancellation_policy,
  price_max_cents, brief_scope, target_platforms, street_address,
  surface_types, install_by, space_size, sponsor_tier, sponsor_slots,
  provenance_status, availability_confirmed_at, instant_booking_enabled,
  availability_dates, booking_duration_days, booking_timezone,
  street_view_captured
);
