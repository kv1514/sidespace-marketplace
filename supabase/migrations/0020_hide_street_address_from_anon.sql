-- Close the direct-API half of the street address exposure.
--
-- listings.street_address is the exact address of a space owner's shop or home.
-- PR #12 stopped it travelling in the page payload by naming columns explicitly
-- on the four public reads (PUBLIC_LISTING_COLUMNS). That fixed what the site
-- SENDS, but not what the API HANDS OVER when asked directly: the row policy
-- makes active listings publicly readable, so
--
--     GET /rest/v1/listings?select=street_address&status=eq.active
--
-- still returned it to anyone holding the publishable key - which ships in the
-- client bundle and is public by design.
--
-- WHY THIS IS NOT A ONE-LINE REVOKE
--
--   revoke select (street_address) on public.listings from anon;
--
-- reports success and does NOTHING. `anon` holds a TABLE-level SELECT grant,
-- and a column-level revoke cannot subtract from one; has_column_privilege
-- still returns true afterwards. The table grant has to go, and every column
-- except this one granted back explicitly. Verified inside a rolled-back
-- transaction before being written here.
--
-- ORDER MATTERS. This could not be applied before PR #12 deployed: the client
-- live until then fetched listings with select("*") as `anon`, and a column
-- `anon` cannot read makes `*` fail outright rather than silently omit it,
-- which would have blanked the marketplace. Readers were narrowed first,
-- deployed, and measured (28 occurrences in the production payload before,
-- 0 after) - then this.
--
-- MAINTENANCE HAZARD, READ BEFORE ADDING A COLUMN
--
-- `anon` no longer has a table-wide grant here, so a column added to
-- public.listings by a LATER migration is NOT readable by signed-out visitors
-- until it is granted. If the new column is meant to be public, that migration
-- must also carry
--
--     grant select (new_column) on public.listings to anon;
--
-- and the column must be added to PUBLIC_LISTING_COLUMNS in
-- lib/supabase/public.ts. Forgetting the grant surfaces as the public
-- marketplace failing to load, not as a missing field.
--
-- The owner is unaffected: `authenticated` keeps its table grant, and every
-- read that returns the address to its owner - loadOwnListings, and the
-- insert/update paths in saveListing - is scoped by owner_profile_id.
--
-- INSERT and UPDATE are deliberately left alone. RLS already gates writes, and
-- narrowing them would buy nothing while widening the blast radius.

revoke select on public.listings from anon;

grant select (
  id, owner_profile_id, title, channel, format, price, price_unit, description,
  demographics, image_url, status, created_at, updated_at, image_urls,
  location_area, availability_notes, available_from, available_to,
  lead_time_days, minimum_booking, deliverables, cancellation_policy,
  price_max, brief_scope, target_platforms, surface_types, install_by,
  space_size, sponsor_tier, sponsor_slots
) on public.listings to anon;
