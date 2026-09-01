-- Anonymous visitors could not read ANY listing, so the marketplace and the
-- home page rendered empty for every logged-out person. Reproduced against
-- production: GET /rest/v1/listings?status=eq.active with the publishable key
-- returned HTTP 401, code 42501, "permission denied for table profiles".
--
-- "Active listings are public" was one policy doing two jobs:
--
--   (status = 'active') OR EXISTS (SELECT 1 FROM profiles
--                                  WHERE profiles.id = listings.owner_profile_id
--                                    AND profiles.auth_user_id = auth.uid())
--
-- The second branch subqueries a DIFFERENT table, so Postgres runs it with the
-- caller's own privileges. 20260831021949_move_private_profile_fields.sql
-- narrowed anon's SELECT on profiles to the public columns, which correctly
-- excluded auth_user_id -- and that took the whole predicate down with it.
-- Postgres checks column privileges across the entire expression; it does not
-- skip the owner branch just because status = 'active' already satisfied the
-- first one. So every anonymous read of listings failed, active or not.
--
-- This is also why the profiles policy kept working: it references
-- auth_user_id on ITS OWN table inside its own USING clause, which the system
-- applies as a row filter rather than as a privileged read of another table.
--
-- Splitting the two jobs restores it. Permissive policies OR together, so the
-- visible behaviour is unchanged -- everyone sees active listings, and a
-- signed-in member additionally sees their own in any status. The difference is
-- that the anonymous path no longer touches profiles at all.
--
-- Verified after applying: anon sees exactly the 29 active listings and zero
-- paused ones, and real titles render on / and /marketplace.

drop policy if exists "Active listings are public" on public.listings;

create policy "Active listings are public"
  on public.listings
  for select
  to public
  using (status = 'active');

create policy "Members read their own listings"
  on public.listings
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles
      where profiles.id = listings.owner_profile_id
        and profiles.auth_user_id = (select auth.uid())
    )
  );
