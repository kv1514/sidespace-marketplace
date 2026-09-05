-- What an owner can see about their own listings, and nothing more.
--
-- Four numbers per listing: how many people saw it, how many opened it, how
-- many liked it, how many made an offer. Impressions and clicks come from
-- public.listing_events; likes reuse the aggregate that already backs the
-- public count; offers are counted straight out of campaign_requests.
--
-- WHY THE COUNTS ARE A DEFINER FUNCTION AND THE VIEW IS NOT
--
-- This is the shape 20260904090000 settled on and the reason is the same here.
-- Nobody may read a raw listing_events row - a visitor_key is exactly the sort
-- of thing that must never leave the database - so the totals have to be
-- computed by something that can see rows the caller cannot. That is the
-- function, and it takes no argument that could select rows: it returns an id
-- and some numbers for every listing, and the view above it decides whose.
--
-- The view is security_invoker over private.current_user_listing_rows(), so
-- "whose" is answered by the listings policy and auth.uid(), in one place,
-- rather than being restated here where it could drift. campaign_requests is
-- read as the caller too, and its own policy already limits a member to
-- requests they are party to, so the offer count needs no special handling.
--
-- Net effect: an owner sees their own four numbers, another member sees an
-- empty set, anon cannot select at all, and no individual liker or visitor is
-- identifiable to anyone. That last part is deliberate - it keeps the promise
-- listing_likes already makes, that a member's like is theirs and only the
-- total is public.
create or replace function private.listing_event_totals()
returns table (
  listing_id uuid,
  impressions bigint,
  clicks bigint,
  impressions_7d bigint,
  clicks_7d bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    event.listing_id,
    count(*) filter (where event.kind = 'impression')::bigint,
    count(*) filter (where event.kind = 'click')::bigint,
    count(*) filter (
      where event.kind = 'impression'
        and event.day > ((now() at time zone 'utc')::date - 7)
    )::bigint,
    count(*) filter (
      where event.kind = 'click'
        and event.day > ((now() at time zone 'utc')::date - 7)
    )::bigint
  from public.listing_events event
  group by event.listing_id;
$$;

revoke all on function private.listing_event_totals()
  from public, anon, authenticated, service_role;
grant execute on function private.listing_event_totals() to authenticated;

create or replace view public.my_listing_analytics
with (security_invoker = true, security_barrier = true)
as
select
  listing.id as listing_id,
  listing.title,
  listing.status,
  listing.created_at,
  coalesce(totals.impressions, 0)::bigint as impressions,
  coalesce(totals.clicks, 0)::bigint as clicks,
  coalesce(totals.impressions_7d, 0)::bigint as impressions_7d,
  coalesce(totals.clicks_7d, 0)::bigint as clicks_7d,
  coalesce(likes.like_count, 0)::bigint as like_count,
  (
    select count(*)
    from public.campaign_requests request
    where request.listing_id = listing.id
  )::bigint as offers
from private.current_user_listing_rows() listing
left join private.listing_event_totals() totals
  on totals.listing_id = listing.id
left join private.listing_like_totals() likes
  on likes.listing_id = listing.id;

revoke all on table public.my_listing_analytics from public, anon, authenticated;
grant select on table public.my_listing_analytics to authenticated;

comment on function private.listing_event_totals() is
  'Non-exposed impression and click totals per listing. Takes no row-selecting argument and returns only an id and counts, so the view above it decides whose listings are visible.';
comment on view public.my_listing_analytics is
  'Security-invoker owner analytics: impressions, clicks, likes and offers for the caller''s own listings only. Never exposes an individual visitor or liker.';
