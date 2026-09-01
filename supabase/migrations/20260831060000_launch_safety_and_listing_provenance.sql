-- Launch-safety controls for marketplace inventory and payment mutations.
--
-- Existing non-demo listings are deliberately NOT assumed to be genuine.
-- They stay visible so the marketplace does not erase user data, but remain
-- view-only until the authenticated owner saves or reactivates the listing.

alter table public.listings
  add column if not exists provenance_status text not null default 'owner_attested',
  add column if not exists availability_confirmed_at timestamptz;

alter table public.listings
  drop constraint if exists listings_provenance_status_valid,
  add constraint listings_provenance_status_valid
    check (provenance_status in (
      'demo', 'unverified', 'owner_attested', 'staff_verified'
    ));

update public.listings listing
set
  provenance_status = case
    when owner.is_demo then 'demo'
    else 'unverified'
  end,
  availability_confirmed_at = null
from public.profiles owner
where owner.id = listing.owner_profile_id;

create or replace function private.enforce_listing_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_is_demo boolean;
  owner_auth_user_id uuid;
begin
  select profile.is_demo, profile.auth_user_id
  into owner_is_demo, owner_auth_user_id
  from public.profiles profile
  where profile.id = new.owner_profile_id;

  if owner_is_demo then
    new.provenance_status := 'demo';
    new.availability_confirmed_at := null;
  elsif (select auth.role()) = 'service_role' then
    -- Staff/server operations may preserve or set a reviewed state.
    new.provenance_status := coalesce(new.provenance_status, 'unverified');
  elsif owner_auth_user_id = (select auth.uid()) then
    -- A save is a first-party attestation, not independent verification.
    new.provenance_status := 'owner_attested';
    new.availability_confirmed_at := clock_timestamp();
  else
    new.provenance_status := 'unverified';
    new.availability_confirmed_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists listings_enforce_provenance on public.listings;
create trigger listings_enforce_provenance
before insert or update on public.listings
for each row execute function private.enforce_listing_provenance();

create index if not exists listings_requestable_idx
  on public.listings (status, availability_confirmed_at desc)
  where provenance_status in ('owner_attested', 'staff_verified');

-- The public marketplace may explain why a row is view-only. Anonymous users
-- still cannot read private addresses or any future listing column by default.
grant select (provenance_status, availability_confirmed_at)
  on public.listings to anon;

-- New campaign requests must point at recently confirmed, non-demo inventory.
-- Existing requests can still be cancelled, but cannot move forward until the
-- owner re-attests the listing by saving or reactivating it.
drop policy if exists "Members create campaign requests" on public.campaign_requests;
create policy "Members create campaign requests"
on public.campaign_requests for insert to authenticated
with check (
  status = 'pending'
  and counter_budget_cents is null
  and counter_message = ''
  and accepted_subtotal_cents is null
  and payer_profile_id is null
  and payee_profile_id is null
  and requester_profile_id <> owner_profile_id
  and not private.blocked_between(requester_profile_id, owner_profile_id)
  and exists (
    select 1 from public.profiles
    where profiles.id = campaign_requests.requester_profile_id
      and profiles.auth_user_id = (select auth.uid())
      and profiles.onboarding_complete
  )
  and exists (
    select 1 from public.listings
    where listings.id = campaign_requests.listing_id
      and listings.owner_profile_id = campaign_requests.owner_profile_id
      and listings.status = 'active'
      and listings.provenance_status in ('owner_attested', 'staff_verified')
      and listings.availability_confirmed_at >= now() - interval '90 days'
  )
);

create or replace function private.require_requestable_campaign_listing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('pending', 'countered', 'accepted') and not exists (
    select 1
    from public.listings listing
    where listing.id = new.listing_id
      and listing.owner_profile_id = new.owner_profile_id
      and listing.status = 'active'
      and listing.provenance_status in ('owner_attested', 'staff_verified')
      and listing.availability_confirmed_at >= now() - interval '90 days'
  ) then
    raise exception 'The listing owner must confirm this inventory before requests can continue.';
  end if;
  return new;
end;
$$;

drop trigger if exists campaign_requests_require_requestable_listing
  on public.campaign_requests;
create trigger campaign_requests_require_requestable_listing
before insert or update of status, listing_id, owner_profile_id
on public.campaign_requests
for each row execute function private.require_requestable_campaign_listing();

-- Durable, cross-instance rate limits for routes that create Stripe objects.
create table if not exists private.payment_rate_limits (
  bucket text not null,
  subject_profile_id uuid not null references public.profiles(id) on delete cascade,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (bucket, subject_profile_id)
);

create or replace function public.claim_payment_rate_limit(
  rate_bucket text,
  subject_profile_id uuid,
  max_requests integer,
  window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row private.payment_rate_limits;
  v_now timestamptz := clock_timestamp();
begin
  if char_length(rate_bucket) not between 1 and 80
     or max_requests not between 1 and 1000
     or window_seconds not between 1 and 86400 then
    raise exception 'Invalid payment rate-limit configuration.';
  end if;

  perform pg_advisory_xact_lock(hashtext(rate_bucket || ':' || subject_profile_id::text));
  select * into current_row
  from private.payment_rate_limits
  where bucket = rate_bucket
    and payment_rate_limits.subject_profile_id = claim_payment_rate_limit.subject_profile_id
  for update;

  if current_row.bucket is null
     or current_row.window_started_at <= v_now - make_interval(secs => window_seconds) then
    insert into private.payment_rate_limits (
      bucket, subject_profile_id, window_started_at, request_count
    ) values (
      rate_bucket, claim_payment_rate_limit.subject_profile_id, v_now, 1
    )
    on conflict on constraint payment_rate_limits_pkey do update
      set window_started_at = excluded.window_started_at,
          request_count = 1;
    return true;
  end if;

  if current_row.request_count >= max_requests then
    return false;
  end if;

  update private.payment_rate_limits
  set request_count = request_count + 1
  where bucket = rate_bucket
    and payment_rate_limits.subject_profile_id = claim_payment_rate_limit.subject_profile_id;
  return true;
end;
$$;

revoke all on function public.claim_payment_rate_limit(text, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_payment_rate_limit(text, uuid, integer, integer)
  to service_role;

revoke all on function private.enforce_listing_provenance() from public, anon, authenticated;
revoke all on function private.require_requestable_campaign_listing() from public, anon, authenticated;

comment on column public.listings.provenance_status is
  'demo, unknown legacy source, authenticated owner attestation, or independent staff verification.';
comment on column public.listings.availability_confirmed_at is
  'Last time the authenticated owner confirmed that this active listing remains requestable.';
