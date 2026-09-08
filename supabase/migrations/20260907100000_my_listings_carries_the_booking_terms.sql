-- Put timing_kind, pricing_kind and minimum_duration_days back on the owner's
-- my_listings projection, and make the file order produce them.
--
-- 20260903073844 added those three columns to public.listings and re-created
-- my_listings to carry them, but it reached the database after 20260903080000
-- and 20260903100000, which sort after it. Two consequences followed. Its
-- select list had to be amended to name street_view_pano, tour_url and
-- tour_kind, since CREATE OR REPLACE VIEW may append columns but never drop
-- them and those two had already added theirs - which made a rebuild from an
-- empty database fail on columns that did not exist yet at that point in the
-- order. And in file order 20260903100000 is the last migration to re-create
-- the projection, so it, not 073844, decides the final column list.
--
-- So 073844 no longer touches the view, and the three columns are appended
-- here, at the end of the order, in the same positions the live database
-- already has them: this is a CREATE OR REPLACE with an identical select list
-- there, and the repair of a from-empty rebuild everywhere else.

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
  street_view_captured, street_view_pano, tour_url, tour_kind,
  timing_kind, pricing_kind, minimum_duration_days
-- See 20260903073000 for why the helper is called bare, with no alias list.
from private.current_user_listing_rows();

notify pgrst, 'reload schema';
