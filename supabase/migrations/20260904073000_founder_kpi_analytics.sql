-- Founder-only KPI reporting.
--
-- The founder dashboard reads one server-side aggregate instead of counting
-- rows in the browser. Money comes from the verified payment ledger, demo and
-- internal accounts are excluded centrally, and lifecycle transitions are
-- recorded by database triggers so a client cannot claim a conversion.

create table if not exists private.founder_kpi_config (
  config_id text primary key check (config_id = 'default'),
  event_tracking_started_at timestamptz not null default clock_timestamp()
);

insert into private.founder_kpi_config (config_id)
values ('default')
on conflict (config_id) do nothing;

create table if not exists private.founder_kpi_events (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in (
    'signup_completed',
    'onboarding_completed',
    'listing_published',
    'request_sent',
    'campaign_accepted',
    'campaign_fulfilled',
    'listing_view'
  )),
  auth_user_id uuid references auth.users(id) on delete set null,
  actor_profile_id uuid references public.profiles(id) on delete set null,
  listing_id uuid references public.listings(id) on delete set null,
  campaign_request_id uuid references public.campaign_requests(id) on delete set null,
  transaction_id uuid references public.payment_transactions(id) on delete set null,
  visitor_hash text check (
    visitor_hash is null or visitor_hash ~ '^[0-9a-f]{64}$'
  ),
  event_day date not null,
  occurred_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb,
  constraint founder_kpi_event_shape check (
    (event_type = 'signup_completed' and auth_user_id is not null)
    or (event_type = 'onboarding_completed' and actor_profile_id is not null)
    or (
      event_type = 'listing_published'
      and actor_profile_id is not null
      and listing_id is not null
    )
    or (
      event_type in ('request_sent', 'campaign_accepted')
      and actor_profile_id is not null
      and campaign_request_id is not null
    )
    or (
      event_type = 'campaign_fulfilled'
      and actor_profile_id is not null
      and transaction_id is not null
    )
    or (
      event_type = 'listing_view'
      and listing_id is not null
      and visitor_hash is not null
    )
  )
);

create index if not exists founder_kpi_events_type_day_idx
  on private.founder_kpi_events (event_type, event_day);
create index if not exists founder_kpi_events_actor_time_idx
  on private.founder_kpi_events (actor_profile_id, occurred_at desc)
  where actor_profile_id is not null;

create unique index if not exists founder_kpi_signup_once_idx
  on private.founder_kpi_events (event_type, auth_user_id)
  where event_type = 'signup_completed' and auth_user_id is not null;
create unique index if not exists founder_kpi_profile_milestone_once_idx
  on private.founder_kpi_events (event_type, actor_profile_id)
  where event_type = 'onboarding_completed' and actor_profile_id is not null;
create unique index if not exists founder_kpi_listing_publish_once_idx
  on private.founder_kpi_events (event_type, listing_id)
  where event_type = 'listing_published' and listing_id is not null;
create unique index if not exists founder_kpi_request_milestone_once_idx
  on private.founder_kpi_events (event_type, campaign_request_id)
  where event_type in ('request_sent', 'campaign_accepted')
    and campaign_request_id is not null;
create unique index if not exists founder_kpi_transaction_milestone_once_idx
  on private.founder_kpi_events (event_type, transaction_id)
  where event_type = 'campaign_fulfilled' and transaction_id is not null;
create unique index if not exists founder_kpi_listing_view_once_per_day_idx
  on private.founder_kpi_events (event_type, listing_id, visitor_hash, event_day)
  where event_type = 'listing_view'
    and listing_id is not null
    and visitor_hash is not null;

alter table private.founder_kpi_config enable row level security;
alter table private.founder_kpi_events enable row level security;
revoke all on table private.founder_kpi_config from public, anon, authenticated, service_role;
revoke all on table private.founder_kpi_events from public, anon, authenticated, service_role;

create or replace function private.record_founder_kpi_event(
  p_event_type text,
  p_auth_user_id uuid default null,
  p_actor_profile_id uuid default null,
  p_listing_id uuid default null,
  p_campaign_request_id uuid default null,
  p_transaction_id uuid default null,
  p_visitor_hash text default null,
  p_occurred_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_time timestamptz := coalesce(p_occurred_at, clock_timestamp());
  inserted_count integer;
begin
  insert into private.founder_kpi_events (
    event_type,
    auth_user_id,
    actor_profile_id,
    listing_id,
    campaign_request_id,
    transaction_id,
    visitor_hash,
    event_day,
    occurred_at,
    metadata
  ) values (
    p_event_type,
    p_auth_user_id,
    p_actor_profile_id,
    p_listing_id,
    p_campaign_request_id,
    p_transaction_id,
    p_visitor_hash,
    (event_time at time zone 'UTC')::date,
    event_time,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count = 1;
end;
$$;

-- Auth signup is the only funnel event that has no public profile row yet.
-- Keep the auth id private and attach the event to the profile when onboarding
-- creates it. A missing profile still represents a real signup in the funnel.
create or replace function private.record_founder_auth_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.record_founder_kpi_event(
    'signup_completed',
    new.id,
    null,
    null,
    null,
    null,
    null,
    new.created_at,
    jsonb_build_object('source', 'auth.users')
  );
  return new;
end;
$$;

drop trigger if exists founder_kpi_auth_signup on auth.users;
create trigger founder_kpi_auth_signup
after insert on auth.users
for each row execute function private.record_founder_auth_signup();

create or replace function private.record_founder_profile_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.auth_user_id is null then
    return new;
  end if;

  -- An auth signup and its profile creation are separate writes. Link them
  -- without exposing auth_user_id through a public projection.
  update private.founder_kpi_events event
  set actor_profile_id = new.id
  where event.event_type = 'signup_completed'
    and event.auth_user_id = new.auth_user_id
    and event.actor_profile_id is null;

  if new.is_demo or new.is_internal then
    return new;
  end if;

  if tg_op = 'INSERT' and new.onboarding_complete then
    perform private.record_founder_kpi_event(
      'onboarding_completed',
      new.auth_user_id,
      new.id,
      null,
      null,
      null,
      null,
      new.created_at,
      jsonb_build_object('source', 'profiles')
    );
  elsif tg_op = 'UPDATE'
    and not old.onboarding_complete
    and new.onboarding_complete then
    perform private.record_founder_kpi_event(
      'onboarding_completed',
      new.auth_user_id,
      new.id,
      null,
      null,
      null,
      null,
      clock_timestamp(),
      jsonb_build_object('source', 'profiles')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists founder_kpi_profile_events on public.profiles;
create trigger founder_kpi_profile_events
after insert or update of onboarding_complete, is_demo, is_internal
on public.profiles
for each row execute function private.record_founder_profile_events();

create or replace function private.record_founder_listing_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_profile public.profiles;
begin
  if new.status <> 'active'
     or (tg_op = 'UPDATE' and old.status = 'active') then
    return new;
  end if;

  select profile.* into owner_profile
  from public.profiles profile
  where profile.id = new.owner_profile_id;
  if owner_profile.id is null or owner_profile.is_demo or owner_profile.is_internal then
    return new;
  end if;

  perform private.record_founder_kpi_event(
    'listing_published',
    owner_profile.auth_user_id,
    owner_profile.id,
    new.id,
    null,
    null,
    null,
    case when tg_op = 'INSERT' then new.created_at else clock_timestamp() end,
    jsonb_build_object('source', 'listings')
  );
  return new;
end;
$$;

drop trigger if exists founder_kpi_listing_events on public.listings;
create trigger founder_kpi_listing_events
after insert or update of status
on public.listings
for each row execute function private.record_founder_listing_events();

create or replace function private.record_founder_request_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requester public.profiles;
  owner public.profiles;
  payer public.profiles;
  accepted_statuses text[] := array['accepted', 'confirmed', 'completed', 'refunded', 'disputed'];
begin
  select profile.* into requester
  from public.profiles profile
  where profile.id = new.requester_profile_id;
  select profile.* into owner
  from public.profiles profile
  where profile.id = new.owner_profile_id;
  select profile.* into payer
  from public.profiles profile
  where profile.id = coalesce(new.payer_profile_id, new.requester_profile_id);

  if requester.id is null or owner.id is null
     or requester.is_demo or requester.is_internal
     or owner.is_demo or owner.is_internal
     or payer.id is null or payer.is_demo or payer.is_internal then
    return new;
  end if;

  if tg_op = 'INSERT' then
    perform private.record_founder_kpi_event(
      'request_sent',
      requester.auth_user_id,
      requester.id,
      null,
      new.id,
      null,
      null,
      new.created_at,
      jsonb_build_object('source', 'campaign_requests')
    );
  end if;

  if new.status = any(accepted_statuses)
     and (
       tg_op = 'INSERT'
       or not (old.status = any(accepted_statuses))
     ) then
    perform private.record_founder_kpi_event(
      'campaign_accepted',
      payer.auth_user_id,
      payer.id,
      null,
      new.id,
      null,
      null,
      case when tg_op = 'INSERT' then new.created_at else clock_timestamp() end,
      jsonb_build_object('source', 'campaign_requests')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists founder_kpi_request_events on public.campaign_requests;
create trigger founder_kpi_request_events
after insert or update of status
on public.campaign_requests
for each row execute function private.record_founder_request_events();

create or replace function private.record_founder_fulfillment_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  creator public.profiles;
  business public.profiles;
begin
  if new.delivered_at is null
     or (tg_op = 'UPDATE' and old.delivered_at is not null) then
    return new;
  end if;

  select profile.* into creator
  from public.profiles profile
  where profile.id = new.creator_profile_id;
  select profile.* into business
  from public.profiles profile
  where profile.id = new.business_profile_id;
  if creator.id is null or business.id is null
     or creator.is_demo or creator.is_internal
     or business.is_demo or business.is_internal then
    return new;
  end if;

  perform private.record_founder_kpi_event(
    'campaign_fulfilled',
    creator.auth_user_id,
    creator.id,
    null,
    null,
    new.id,
    null,
    new.delivered_at,
    jsonb_build_object('source', 'payment_transactions')
  );
  return new;
end;
$$;

drop trigger if exists founder_kpi_fulfillment_events on public.payment_transactions;
create trigger founder_kpi_fulfillment_events
after insert or update of delivered_at
on public.payment_transactions
for each row execute function private.record_founder_fulfillment_events();

-- Seed only facts whose timestamps already exist. Acceptance is intentionally
-- not backfilled: legacy campaign rows do not retain the moment both parties
-- accepted, so inventing a date would make the founder report look precise
-- while being wrong. New acceptance transitions are tracked above.
insert into private.founder_kpi_events (
  event_type, auth_user_id, actor_profile_id, event_day, occurred_at, metadata
)
select
  'signup_completed',
  account.id,
  profile.id,
  (account.created_at at time zone 'UTC')::date,
  account.created_at,
  jsonb_build_object('source', 'backfill:auth.users')
from auth.users account
left join public.profiles profile on profile.auth_user_id = account.id
on conflict do nothing;

insert into private.founder_kpi_events (
  event_type, auth_user_id, actor_profile_id, listing_id,
  event_day, occurred_at, metadata
)
select
  'listing_published',
  owner.auth_user_id,
  owner.id,
  listing.id,
  (listing.created_at at time zone 'UTC')::date,
  listing.created_at,
  jsonb_build_object('source', 'backfill:listings')
from public.listings listing
join public.profiles owner on owner.id = listing.owner_profile_id
where listing.status = 'active'
  and not owner.is_demo
  and not owner.is_internal
on conflict do nothing;

insert into private.founder_kpi_events (
  event_type, auth_user_id, actor_profile_id, campaign_request_id,
  event_day, occurred_at, metadata
)
select
  'request_sent',
  requester.auth_user_id,
  requester.id,
  request.id,
  (request.created_at at time zone 'UTC')::date,
  request.created_at,
  jsonb_build_object('source', 'backfill:campaign_requests')
from public.campaign_requests request
join public.profiles requester on requester.id = request.requester_profile_id
join public.profiles owner on owner.id = request.owner_profile_id
where not requester.is_demo
  and not requester.is_internal
  and not owner.is_demo
  and not owner.is_internal
on conflict do nothing;

insert into private.founder_kpi_events (
  event_type, auth_user_id, actor_profile_id, transaction_id,
  event_day, occurred_at, metadata
)
select
  'campaign_fulfilled',
  creator.auth_user_id,
  creator.id,
  transaction.id,
  (transaction.delivered_at at time zone 'UTC')::date,
  transaction.delivered_at,
  jsonb_build_object('source', 'backfill:payment_transactions')
from public.payment_transactions transaction
join public.profiles creator on creator.id = transaction.creator_profile_id
join public.profiles business on business.id = transaction.business_profile_id
where transaction.delivered_at is not null
  and not creator.is_demo
  and not creator.is_internal
  and not business.is_demo
  and not business.is_internal
on conflict do nothing;

-- This is the only browser-facing write path, and it is callable only by the
-- server route. The route supplies an HMAC of a random first-party cookie;
-- Postgres enforces the active-listing and per-visitor-per-day boundaries.
create or replace function public.record_listing_view(
  target_listing_id uuid,
  viewer_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  listing_time timestamptz := clock_timestamp();
  owner_profile public.profiles;
begin
  if viewer_hash is null or viewer_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  select profile.* into owner_profile
  from public.listings listing
  join public.profiles profile on profile.id = listing.owner_profile_id
  where listing.id = target_listing_id
    and listing.status = 'active'
    and profile.suspended_at is null;
  if owner_profile.id is null or owner_profile.is_demo or owner_profile.is_internal then
    return false;
  end if;

  return private.record_founder_kpi_event(
    'listing_view',
    null,
    null,
    target_listing_id,
    null,
    null,
    viewer_hash,
    listing_time,
    jsonb_build_object('source', 'listing_detail_open')
  );
end;
$$;

-- One aggregate read is exposed to the server role. Browser roles get neither
-- the event table nor the reporting function.
create or replace function public.get_sidespace_founder_kpis(period_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_days integer := coalesce(period_days, 30);
  period_end timestamptz;
  period_start timestamptz;
  tracking_started_at timestamptz;
  members_total bigint := 0;
  members_onboarded bigint := 0;
  businesses_total bigint := 0;
  creators_total bigint := 0;
  listings_total bigint := 0;
  active_listings bigint := 0;
  requestable_listings bigint := 0;
  open_requests bigint := 0;
  paid_campaigns_total bigint := 0;
  fulfilled_campaigns_total bigint := 0;
  repeat_businesses_total bigint := 0;
  pending_payout_cents bigint := 0;
  released_payouts_total_cents bigint := 0;
  open_payment_issues bigint := 0;
  disputed_payments bigint := 0;
  ad_credit_outstanding_cents bigint := 0;
  listing_views bigint := 0;
  unique_listing_viewers bigint := 0;
  new_members bigint := 0;
  onboarding_completed bigint := 0;
  listings_published bigint := 0;
  requests_sent bigint := 0;
  campaigns_accepted bigint := 0;
  paid_campaigns bigint := 0;
  campaigns_fulfilled bigint := 0;
  repeat_businesses bigint := 0;
  gmv_cents bigint := 0;
  cash_collected_cents bigint := 0;
  platform_gross_revenue_cents bigint := 0;
  tax_collected_cents bigint := 0;
  ad_credits_applied_cents bigint := 0;
  refunds_cents bigint := 0;
  payouts_released_cents bigint := 0;
  payment_failures bigint := 0;
  request_statuses jsonb := '{}'::jsonb;
  payment_statuses jsonb := '{}'::jsonb;
  listing_channels jsonb := '{}'::jsonb;
  daily jsonb := '[]'::jsonb;
begin
  if requested_days not between 1 and 365 then
    raise exception 'KPI period must be between 1 and 365 days.';
  end if;

  period_end := (
    date_trunc('day', clock_timestamp() at time zone 'UTC') + interval '1 day'
  ) at time zone 'UTC';
  period_start := period_end - make_interval(days => requested_days);

  select config.event_tracking_started_at
  into tracking_started_at
  from private.founder_kpi_config config
  where config.config_id = 'default';

  select count(*)
  into members_total
  from public.profiles profile
  where profile.auth_user_id is not null
    and not profile.is_demo
    and not profile.is_internal;

  select count(*)
  into members_onboarded
  from public.profiles profile
  where profile.auth_user_id is not null
    and profile.onboarding_complete
    and not profile.is_demo
    and not profile.is_internal;

  select count(*)
  into businesses_total
  from public.profiles profile
  where not profile.is_demo
    and not profile.is_internal
    and (
      profile.role = 'business'
      or 'business' = any(coalesce(profile.extra_roles, '{}'::text[]))
    );

  select count(*)
  into creators_total
  from public.profiles profile
  where not profile.is_demo
    and not profile.is_internal
    and (
      profile.role in ('creator', 'space_owner', 'sponsor_host')
      or 'creator' = any(coalesce(profile.extra_roles, '{}'::text[]))
      or 'space_owner' = any(coalesce(profile.extra_roles, '{}'::text[]))
      or 'sponsor_host' = any(coalesce(profile.extra_roles, '{}'::text[]))
    );

  select count(*)
  into listings_total
  from public.listings listing
  join public.profiles owner on owner.id = listing.owner_profile_id
  where not owner.is_demo and not owner.is_internal;

  select count(*)
  into active_listings
  from public.listings listing
  join public.profiles owner on owner.id = listing.owner_profile_id
  where listing.status = 'active'
    and not owner.is_demo
    and not owner.is_internal
    and owner.suspended_at is null;

  select count(*)
  into requestable_listings
  from public.listings listing
  join public.profiles owner on owner.id = listing.owner_profile_id
  where listing.status = 'active'
    and listing.provenance_status in ('owner_attested', 'staff_verified')
    and listing.availability_confirmed_at >= now() - interval '90 days'
    and owner.onboarding_complete
    and owner.suspended_at is null
    and not owner.is_demo
    and not owner.is_internal;

  select count(*)
  into open_requests
  from public.campaign_requests request
  join public.profiles requester on requester.id = request.requester_profile_id
  join public.profiles owner on owner.id = request.owner_profile_id
  where request.status in ('pending', 'countered', 'accepted', 'confirmed')
    and not requester.is_demo and not requester.is_internal
    and not owner.is_demo and not owner.is_internal;

  select count(*)
  into paid_campaigns_total
  from public.payment_transactions transaction
  join public.profiles business on business.id = transaction.business_profile_id
  join public.profiles creator on creator.id = transaction.creator_profile_id
  where transaction.paid_at is not null
    and not business.is_demo and not business.is_internal
    and not creator.is_demo and not creator.is_internal;

  select count(*)
  into fulfilled_campaigns_total
  from public.payment_transactions transaction
  join public.profiles business on business.id = transaction.business_profile_id
  join public.profiles creator on creator.id = transaction.creator_profile_id
  where transaction.paid_at is not null
    and transaction.delivered_at is not null
    and not business.is_demo and not business.is_internal
    and not creator.is_demo and not creator.is_internal;

  select count(*)
  into repeat_businesses_total
  from (
    select transaction.business_profile_id
    from public.payment_transactions transaction
    join public.profiles business on business.id = transaction.business_profile_id
    join public.profiles creator on creator.id = transaction.creator_profile_id
    where transaction.paid_at is not null
      and not business.is_demo and not business.is_internal
      and not creator.is_demo and not creator.is_internal
    group by transaction.business_profile_id
    having count(*) >= 2
  ) repeat_rows;

  select
    coalesce(sum(transaction.payout_amount_cents)
      filter (where transaction.payout_status in ('pending', 'releasing', 'blocked')), 0),
    coalesce(sum(transaction.payout_amount_cents)
      filter (where transaction.payout_status = 'released'), 0)
  into pending_payout_cents, released_payouts_total_cents
  from public.payment_transactions transaction
  join public.profiles business on business.id = transaction.business_profile_id
  join public.profiles creator on creator.id = transaction.creator_profile_id
  where transaction.paid_at is not null
    and not business.is_demo and not business.is_internal
    and not creator.is_demo and not creator.is_internal;

  select count(*)
  into open_payment_issues
  from public.payment_issues issue
  join public.payment_transactions transaction on transaction.id = issue.transaction_id
  join public.profiles business on business.id = transaction.business_profile_id
  join public.profiles creator on creator.id = transaction.creator_profile_id
  where issue.status in ('open', 'escalated', 'resolution_pending')
    and not business.is_demo and not business.is_internal
    and not creator.is_demo and not creator.is_internal;

  select count(*)
  into disputed_payments
  from public.payment_transactions transaction
  join public.profiles business on business.id = transaction.business_profile_id
  join public.profiles creator on creator.id = transaction.creator_profile_id
  where transaction.status = 'disputed'
    and not business.is_demo and not business.is_internal
    and not creator.is_demo and not creator.is_internal;

  select coalesce(sum(ledger.amount_cents), 0)
  into ad_credit_outstanding_cents
  from public.business_ad_credit_ledger ledger
  join public.profiles business on business.id = ledger.business_profile_id
  where business.role = 'business'
    and not business.is_demo
    and not business.is_internal;

  select count(*)
  into listing_views
  from private.founder_kpi_events event
  where event.event_type = 'listing_view'
    and event.occurred_at >= period_start
    and event.occurred_at < period_end;

  select count(distinct event.visitor_hash)
  into unique_listing_viewers
  from private.founder_kpi_events event
  where event.event_type = 'listing_view'
    and event.occurred_at >= period_start
    and event.occurred_at < period_end;

  select count(*)
  into new_members
  from private.founder_kpi_events event
  where event.event_type = 'signup_completed'
    and event.occurred_at >= period_start
    and event.occurred_at < period_end
    and not exists (
      select 1
      from public.profiles profile
      where profile.auth_user_id = event.auth_user_id
        and (profile.is_demo or profile.is_internal)
    );

  select count(*)
  into onboarding_completed
  from private.founder_kpi_events event
  join public.profiles profile on profile.id = event.actor_profile_id
  where event.event_type = 'onboarding_completed'
    and event.occurred_at >= period_start
    and event.occurred_at < period_end
    and not profile.is_demo
    and not profile.is_internal;

  select count(*)
  into listings_published
  from private.founder_kpi_events event
  join public.profiles owner on owner.id = event.actor_profile_id
  where event.event_type = 'listing_published'
    and event.occurred_at >= period_start
    and event.occurred_at < period_end
    and not owner.is_demo
    and not owner.is_internal;

  select count(*)
  into requests_sent
  from private.founder_kpi_events event
  join public.profiles requester on requester.id = event.actor_profile_id
  where event.event_type = 'request_sent'
    and event.occurred_at >= period_start
    and event.occurred_at < period_end
    and not requester.is_demo
    and not requester.is_internal;

  select count(*)
  into campaigns_accepted
  from private.founder_kpi_events event
  join public.profiles actor on actor.id = event.actor_profile_id
  where event.event_type = 'campaign_accepted'
    and event.occurred_at >= period_start
    and event.occurred_at < period_end
    and not actor.is_demo
    and not actor.is_internal;

  select count(*)
  into paid_campaigns
  from public.payment_transactions transaction
  join public.profiles business on business.id = transaction.business_profile_id
  join public.profiles creator on creator.id = transaction.creator_profile_id
  where transaction.paid_at >= period_start
    and transaction.paid_at < period_end
    and not business.is_demo and not business.is_internal
    and not creator.is_demo and not creator.is_internal;

  select count(*)
  into campaigns_fulfilled
  from public.payment_transactions transaction
  join public.profiles business on business.id = transaction.business_profile_id
  join public.profiles creator on creator.id = transaction.creator_profile_id
  where transaction.delivered_at >= period_start
    and transaction.delivered_at < period_end
    and transaction.paid_at is not null
    and not business.is_demo and not business.is_internal
    and not creator.is_demo and not creator.is_internal;

  select count(*)
  into repeat_businesses
  from (
    select transaction.business_profile_id
    from public.payment_transactions transaction
    join public.profiles business on business.id = transaction.business_profile_id
    join public.profiles creator on creator.id = transaction.creator_profile_id
    where transaction.paid_at >= period_start
      and transaction.paid_at < period_end
      and not business.is_demo and not business.is_internal
      and not creator.is_demo and not creator.is_internal
    group by transaction.business_profile_id
    having count(*) >= 2
  ) repeat_rows;

  select
    coalesce(sum(transaction.subtotal_cents), 0),
    coalesce(sum(transaction.charged_total_cents + transaction.tax_cents), 0),
    coalesce(sum(transaction.platform_gross_revenue_cents), 0),
    coalesce(sum(transaction.tax_cents), 0),
    coalesce(sum(transaction.ad_credit_cents), 0)
  into
    gmv_cents,
    cash_collected_cents,
    platform_gross_revenue_cents,
    tax_collected_cents,
    ad_credits_applied_cents
  from public.payment_transactions transaction
  join public.profiles business on business.id = transaction.business_profile_id
  join public.profiles creator on creator.id = transaction.creator_profile_id
  where transaction.paid_at >= period_start
    and transaction.paid_at < period_end
    and not business.is_demo and not business.is_internal
    and not creator.is_demo and not creator.is_internal;

  select coalesce(sum(refund.amount_cents), 0)
  into refunds_cents
  from public.payment_refunds refund
  join public.payment_transactions transaction on transaction.id = refund.transaction_id
  join public.profiles business on business.id = transaction.business_profile_id
  join public.profiles creator on creator.id = transaction.creator_profile_id
  where refund.status = 'succeeded'
    and refund.created_at >= period_start
    and refund.created_at < period_end
    and not business.is_demo and not business.is_internal
    and not creator.is_demo and not creator.is_internal;

  select coalesce(sum(transaction.payout_amount_cents), 0)
  into payouts_released_cents
  from public.payment_transactions transaction
  join public.profiles business on business.id = transaction.business_profile_id
  join public.profiles creator on creator.id = transaction.creator_profile_id
  where transaction.payout_released_at >= period_start
    and transaction.payout_released_at < period_end
    and transaction.payout_status = 'released'
    and not business.is_demo and not business.is_internal
    and not creator.is_demo and not creator.is_internal;

  select count(*)
  into payment_failures
  from public.payment_transactions transaction
  join public.profiles business on business.id = transaction.business_profile_id
  join public.profiles creator on creator.id = transaction.creator_profile_id
  where transaction.status = 'payment_failed'
    and transaction.updated_at >= period_start
    and transaction.updated_at < period_end
    and not business.is_demo and not business.is_internal
    and not creator.is_demo and not creator.is_internal;

  select coalesce(jsonb_object_agg(status_rows.status, status_rows.total order by status_rows.status), '{}'::jsonb)
  into request_statuses
  from (
    select request.status, count(*) as total
    from public.campaign_requests request
    join public.profiles requester on requester.id = request.requester_profile_id
    join public.profiles owner on owner.id = request.owner_profile_id
    where not requester.is_demo and not requester.is_internal
      and not owner.is_demo and not owner.is_internal
    group by request.status
  ) status_rows;

  select coalesce(jsonb_object_agg(status_rows.status, status_rows.total order by status_rows.status), '{}'::jsonb)
  into payment_statuses
  from (
    select transaction.status, count(*) as total
    from public.payment_transactions transaction
    join public.profiles business on business.id = transaction.business_profile_id
    join public.profiles creator on creator.id = transaction.creator_profile_id
    where not business.is_demo and not business.is_internal
      and not creator.is_demo and not creator.is_internal
    group by transaction.status
  ) status_rows;

  select coalesce(jsonb_object_agg(channel_rows.channel, channel_rows.total order by channel_rows.channel), '{}'::jsonb)
  into listing_channels
  from (
    select listing.channel, count(*) as total
    from public.listings listing
    join public.profiles owner on owner.id = listing.owner_profile_id
    where listing.status = 'active'
      and not owner.is_demo
      and not owner.is_internal
      and owner.suspended_at is null
    group by listing.channel
  ) channel_rows;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'date', daily_rows.day,
      'listing_views', daily_rows.listing_views,
      'new_members', daily_rows.new_members,
      'requests_sent', daily_rows.requests_sent,
      'campaigns_accepted', daily_rows.campaigns_accepted,
      'paid_campaigns', daily_rows.paid_campaigns,
      'campaigns_fulfilled', daily_rows.campaigns_fulfilled,
      'gmv_cents', daily_rows.gmv_cents,
      'platform_gross_revenue_cents', daily_rows.platform_gross_revenue_cents
    ) order by daily_rows.day
  ), '[]'::jsonb)
  into daily
  from (
    select
      calendar.day::date as day,
      coalesce(view_rows.total, 0) as listing_views,
      coalesce(member_rows.total, 0) as new_members,
      coalesce(request_rows.total, 0) as requests_sent,
      coalesce(accepted_rows.total, 0) as campaigns_accepted,
      coalesce(paid_rows.total, 0) as paid_campaigns,
      coalesce(fulfilled_rows.total, 0) as campaigns_fulfilled,
      coalesce(paid_rows.gmv_cents, 0) as gmv_cents,
      coalesce(paid_rows.platform_gross_revenue_cents, 0) as platform_gross_revenue_cents
    from generate_series(
      period_start::date,
      (period_end - interval '1 day')::date,
      interval '1 day'
    ) calendar(day)
    left join (
      select event.event_day as day, count(*) as total
      from private.founder_kpi_events event
      where event.event_type = 'listing_view'
        and event.event_day >= period_start::date
        and event.event_day < period_end::date
      group by event.event_day
    ) view_rows on view_rows.day = calendar.day::date
    left join (
      select event.event_day as day, count(*) as total
      from private.founder_kpi_events event
      where event.event_type = 'signup_completed'
        and event.occurred_at >= period_start
        and event.occurred_at < period_end
        and not exists (
          select 1
          from public.profiles profile
          where profile.auth_user_id = event.auth_user_id
            and (profile.is_demo or profile.is_internal)
        )
      group by event.event_day
    ) member_rows on member_rows.day = calendar.day::date
    left join (
      select event.event_day as day, count(*) as total
      from private.founder_kpi_events event
      join public.profiles requester on requester.id = event.actor_profile_id
      where event.event_type = 'request_sent'
        and not requester.is_demo
        and not requester.is_internal
      group by event.event_day
    ) request_rows on request_rows.day = calendar.day::date
    left join (
      select event.event_day as day, count(*) as total
      from private.founder_kpi_events event
      join public.profiles actor on actor.id = event.actor_profile_id
      where event.event_type = 'campaign_accepted'
        and not actor.is_demo
        and not actor.is_internal
      group by event.event_day
    ) accepted_rows on accepted_rows.day = calendar.day::date
    left join (
      select
        (transaction.paid_at at time zone 'UTC')::date as day,
        count(*) as total,
        sum(transaction.subtotal_cents) as gmv_cents,
        sum(transaction.platform_gross_revenue_cents) as platform_gross_revenue_cents
      from public.payment_transactions transaction
      join public.profiles business on business.id = transaction.business_profile_id
      join public.profiles creator on creator.id = transaction.creator_profile_id
      where transaction.paid_at >= period_start
        and transaction.paid_at < period_end
        and not business.is_demo and not business.is_internal
        and not creator.is_demo and not creator.is_internal
      group by (transaction.paid_at at time zone 'UTC')::date
    ) paid_rows on paid_rows.day = calendar.day::date
    left join (
      select (transaction.delivered_at at time zone 'UTC')::date as day, count(*) as total
      from public.payment_transactions transaction
      join public.profiles business on business.id = transaction.business_profile_id
      join public.profiles creator on creator.id = transaction.creator_profile_id
      where transaction.delivered_at >= period_start
        and transaction.delivered_at < period_end
        and transaction.paid_at is not null
        and not business.is_demo and not business.is_internal
        and not creator.is_demo and not creator.is_internal
      group by (transaction.delivered_at at time zone 'UTC')::date
    ) fulfilled_rows on fulfilled_rows.day = calendar.day::date
  ) daily_rows;

  return jsonb_build_object(
    'generated_at', clock_timestamp(),
    'period', jsonb_build_object(
      'days', requested_days,
      'start', period_start,
      'end', period_end,
      'timezone', 'UTC'
    ),
    'tracking', jsonb_build_object(
      'event_tracking_started_at', tracking_started_at,
      'acceptance_events_started_at', tracking_started_at,
      'legacy_acceptance_dates_available', false
    ),
    'snapshot', jsonb_build_object(
      'members_total', members_total,
      'members_onboarded', members_onboarded,
      'businesses_total', businesses_total,
      'creators_total', creators_total,
      'listings_total', listings_total,
      'active_listings', active_listings,
      'requestable_listings', requestable_listings,
      'open_requests', open_requests,
      'paid_campaigns_total', paid_campaigns_total,
      'fulfilled_campaigns_total', fulfilled_campaigns_total,
      'repeat_businesses_total', repeat_businesses_total,
      'pending_payout_cents', pending_payout_cents,
      'released_payouts_total_cents', released_payouts_total_cents,
      'open_payment_issues', open_payment_issues,
      'disputed_payments', disputed_payments,
      'ad_credit_outstanding_cents', ad_credit_outstanding_cents
    ),
    'period_metrics', jsonb_build_object(
      'listing_views', listing_views,
      'unique_listing_viewers', unique_listing_viewers,
      'new_members', new_members,
      'onboarding_completed', onboarding_completed,
      'listings_published', listings_published,
      'requests_sent', requests_sent,
      'campaigns_accepted', campaigns_accepted,
      'paid_campaigns', paid_campaigns,
      'campaigns_fulfilled', campaigns_fulfilled,
      'repeat_businesses', repeat_businesses,
      'gmv_cents', gmv_cents,
      'cash_collected_cents', cash_collected_cents,
      'platform_gross_revenue_cents', platform_gross_revenue_cents,
      'tax_collected_cents', tax_collected_cents,
      'ad_credits_applied_cents', ad_credits_applied_cents,
      'refunds_cents', refunds_cents,
      'payouts_released_cents', payouts_released_cents,
      'payment_failures', payment_failures
    ),
    'breakdowns', jsonb_build_object(
      'request_statuses', request_statuses,
      'payment_statuses', payment_statuses,
      'active_listing_channels', listing_channels
    ),
    'daily', daily
  );
end;
$$;

revoke all on function private.record_founder_kpi_event(
  text, uuid, uuid, uuid, uuid, uuid, text, timestamptz, jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.record_founder_auth_signup() from public, anon, authenticated, service_role;
revoke all on function private.record_founder_profile_events() from public, anon, authenticated, service_role;
revoke all on function private.record_founder_listing_events() from public, anon, authenticated, service_role;
revoke all on function private.record_founder_request_events() from public, anon, authenticated, service_role;
revoke all on function private.record_founder_fulfillment_events() from public, anon, authenticated, service_role;
revoke all on function public.record_listing_view(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_listing_view(uuid, text) to service_role;
revoke all on function public.get_sidespace_founder_kpis(integer)
  from public, anon, authenticated;
grant execute on function public.get_sidespace_founder_kpis(integer) to service_role;

comment on table private.founder_kpi_events is
  'Private, trigger-recorded funnel events and deduplicated listing views for the founder KPI report.';
comment on function public.record_listing_view(uuid, text) is
  'Server-only listing-detail view recorder; one HMAC visitor can count once per listing per UTC day.';
comment on function public.get_sidespace_founder_kpis(integer) is
  'Server-only aggregate SideSpace KPI report. Excludes demo and internal accounts and uses verified payment timestamps.';
