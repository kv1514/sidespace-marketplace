-- Let the listings policy decide who may be counted, instead of the view.
--
-- `listing_like_counts` was the last view in `public` still running as its
-- owner rather than as the caller, and it re-stated the listings policy in its
-- own WHERE clause. When 20260904055617 added suspension to that policy, this
-- copy of it was not updated, so a suspended member's active listing ids and
-- like counts stayed readable by anon - which is the one thing suspending an
-- account is supposed to stop: "their listings go with them, whatever status
-- the rows carry".
--
-- Adding the missing predicate would fix today's drift and arrange the next
-- one. The view now reads `public.listings` as the caller instead, so the
-- listings policy is the single place that decides which listings anyone can
-- see, here as everywhere else.
--
-- Only the aggregate has to stay SECURITY DEFINER: a member may read just
-- their own rows in `listing_likes`, and a public count has to see all of
-- them. It lives in the non-exposed `private` schema, takes no argument that
-- could select rows, and returns nothing but a listing id and a number - so
-- what it can leak is a count for a listing whose id the caller already had.
-- Which listings a caller may ask about is decided by the view above it.
create or replace function private.listing_like_totals()
returns table (listing_id uuid, like_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select like_row.listing_id, count(*)::bigint
  from public.listing_likes like_row
  group by like_row.listing_id;
$$;

revoke all on function private.listing_like_totals()
  from public, anon, authenticated, service_role;
grant execute on function private.listing_like_totals() to anon, authenticated;

drop view if exists public.listing_like_counts;
create view public.listing_like_counts
with (security_invoker = true, security_barrier = true)
as
select
  listing.id as listing_id,
  coalesce(total.like_count, 0)::bigint as like_count
from public.listings listing
left join private.listing_like_totals() total on total.listing_id = listing.id
-- Internal and suspended owners are the listings policy's business now. Demo
-- owners are not: their listings are public on purpose, they just cannot be
-- liked, so they carry no count.
where listing.status = 'active'
  and not private.profile_is_demo(listing.owner_profile_id);

revoke all on table public.listing_like_counts from public, anon, authenticated;
grant select on table public.listing_like_counts to anon, authenticated;
