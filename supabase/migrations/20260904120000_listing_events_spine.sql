-- What a listing's audience actually looks like, recorded once per person per day.
--
-- Nothing in this product has ever recorded a view or a click. Vercel Analytics
-- collects pageviews, but they are not queryable from the app and carry no
-- listing id, so an owner has never been able to answer "did anyone see it?".
-- Likes and offers exist but are the far end of the funnel: with 19 active
-- listings there are 0 likes and 1 request, and a member who gets no offers
-- cannot tell whether the listing is wrong or simply unseen. That is the gap.
--
-- WHY THE PRIMARY KEY IS THE DEDUPE
--
-- The key is (listing_id, kind, visitor_key, day), so scrolling a card past the
-- viewport twenty times in an afternoon counts once. "Impressions" therefore
-- means people-reached-per-day rather than raw paint count. That is the number
-- an owner can actually reason about, it keeps clicks <= impressions so a
-- click-through rate means something, and it removes the cheapest way to
-- inflate the figure. The cost is that we cannot answer "how many times" - only
-- "how many people, on how many days" - which is the better trade for a
-- marketplace this size.
--
-- WHY NOTHING HERE IS CLIENT-WRITABLE
--
-- Owners will make decisions from these numbers, so the browser never inserts.
-- Writes arrive through /api/listings/events with the service role, which drops
-- an owner's traffic on their own listing before it is ever recorded. Reads
-- happen only through the aggregate in the next migration; no role can select
-- rows here, so a visitor_key is never exposed to anyone.
create table if not exists public.listing_events (
  listing_id uuid not null references public.listings(id) on delete cascade,
  kind text not null check (kind in ('impression', 'click')),
  -- An opaque per-browser id, or 'u:<auth uid>' once someone signs in. Never an
  -- email, a name, or an address - it exists to deduplicate and to pair two
  -- listings the same person looked at, nothing else.
  visitor_key text not null,
  -- Kept alongside visitor_key so a deleted account takes its rows' identity
  -- with it while the aggregate counts survive.
  user_id uuid references auth.users(id) on delete set null,
  day date not null default (now() at time zone 'utc')::date,
  created_at timestamptz not null default now(),
  primary key (listing_id, kind, visitor_key, day)
);

-- Reading a listing's own history, and walking one visitor's trail to pair
-- listings together, are the only two access paths the aggregates need.
create index if not exists listing_events_listing_day_idx
  on public.listing_events (listing_id, day desc);
create index if not exists listing_events_visitor_idx
  on public.listing_events (visitor_key, day desc);

alter table public.listing_events enable row level security;

-- No policies, deliberately: RLS with no policy denies everything, and there is
-- no role that should read a raw row. service_role bypasses RLS and is how the
-- ingest route writes.
revoke all on table public.listing_events from public, anon, authenticated;
grant all on table public.listing_events to service_role;

comment on table public.listing_events is
  'One row per listing, kind, visitor and UTC day. Written only by the events API as service_role; read only through the aggregates in public.my_listing_analytics. No role may select rows directly.';
