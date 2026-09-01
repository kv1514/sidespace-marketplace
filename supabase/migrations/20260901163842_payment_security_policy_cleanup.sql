-- The remote-only lineage exposed owner listings through this policy. The
-- owner-scoped my_listings view is now the only browser read path needed.
drop policy if exists "Members read their own listings" on public.listings;
