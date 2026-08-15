alter table public.profiles
  add column if not exists verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'pending', 'verified', 'rejected')),
  add column if not exists social_verification jsonb not null default '{}'::jsonb;

update public.profiles
set verification_status = 'verified'
where verified;

create or replace function public.protect_profile_trust_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.verified = false;
      new.verification_status = 'unverified';
      new.social_verification = '{}'::jsonb;
      new.is_demo = false;
    else
      new.auth_user_id = old.auth_user_id;
      new.verified = old.verified;
      new.verification_status = old.verification_status;
      new.social_verification = old.social_verification;
      new.is_demo = old.is_demo;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_trust_fields on public.profiles;
create trigger profiles_protect_trust_fields
before insert or update on public.profiles
for each row execute function public.protect_profile_trust_fields();

alter table public.listings
  add column if not exists location_area text not null default '',
  add column if not exists availability_notes text not null default '',
  add column if not exists available_from date,
  add column if not exists available_to date,
  add column if not exists lead_time_days integer not null default 0
    check (lead_time_days >= 0),
  add column if not exists minimum_booking text not null default '',
  add column if not exists deliverables text not null default '',
  add column if not exists cancellation_policy text not null default '';

create table if not exists public.campaign_requests (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  requester_profile_id uuid not null references public.profiles(id) on delete cascade,
  owner_profile_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  campaign_name text not null check (char_length(trim(campaign_name)) between 2 and 120),
  goals text not null check (char_length(trim(goals)) between 10 and 1500),
  requested_deliverables text not null check (char_length(trim(requested_deliverables)) between 2 and 1000),
  budget integer not null check (budget >= 0),
  start_date date not null,
  end_date date not null,
  notes text not null default '' check (char_length(notes) <= 2000),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'countered', 'cancelled', 'completed')),
  counter_budget integer check (counter_budget is null or counter_budget >= 0),
  counter_message text not null default '' check (char_length(counter_message) <= 1500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_dates_in_order check (end_date >= start_date),
  constraint campaign_members_differ check (requester_profile_id <> owner_profile_id)
);

create index if not exists campaign_requests_requester_idx
  on public.campaign_requests (requester_profile_id, updated_at desc);
create index if not exists campaign_requests_owner_idx
  on public.campaign_requests (owner_profile_id, updated_at desc);
create index if not exists campaign_requests_listing_idx
  on public.campaign_requests (listing_id, created_at desc);

drop trigger if exists campaign_requests_set_updated_at on public.campaign_requests;
create trigger campaign_requests_set_updated_at
before update on public.campaign_requests
for each row execute function public.set_updated_at();

create table if not exists public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  verification_type text not null
    check (verification_type in ('business', 'creator', 'space_owner')),
  evidence_url text not null default '',
  social_platform text not null default '',
  social_handle text not null default '',
  message text not null default '' check (char_length(message) <= 1500),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists public.profile_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_profile_id uuid not null references public.profiles(id) on delete cascade,
  reported_profile_id uuid not null references public.profiles(id) on delete cascade,
  listing_id uuid references public.listings(id) on delete set null,
  reason text not null
    check (reason in ('misleading', 'spam', 'unsafe', 'impersonation', 'other')),
  details text not null default '' check (char_length(details) <= 2000),
  status text not null default 'open'
    check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  constraint profile_reports_not_self check (reporter_profile_id <> reported_profile_id)
);

create index if not exists profile_reports_reporter_idx
  on public.profile_reports (reporter_profile_id, created_at desc);
create index if not exists profile_reports_reported_idx
  on public.profile_reports (reported_profile_id, created_at desc);

create table if not exists public.profile_blocks (
  blocker_profile_id uuid not null references public.profiles(id) on delete cascade,
  blocked_profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_profile_id, blocked_profile_id),
  constraint profile_blocks_not_self check (blocker_profile_id <> blocked_profile_id)
);

create or replace function public.sync_profile_verification_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set
    verification_status = case new.status
      when 'approved' then 'verified'
      when 'rejected' then 'rejected'
      else 'pending'
    end,
    verified = (new.status = 'approved')
  where id = new.profile_id;
  return new;
end;
$$;

drop trigger if exists verification_request_sync_profile on public.verification_requests;
create trigger verification_request_sync_profile
after insert or update of status on public.verification_requests
for each row execute function public.sync_profile_verification_status();

create or replace function public.respond_campaign_request(
  request_id uuid,
  next_status text,
  proposed_budget integer default null,
  response_message text default ''
)
returns public.campaign_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  own_profile_id uuid;
  current_request public.campaign_requests;
begin
  select id into own_profile_id
  from public.profiles
  where auth_user_id = auth.uid();

  select * into current_request
  from public.campaign_requests
  where id = request_id;

  if current_request.id is null then
    raise exception 'Campaign request not found.';
  end if;

  if own_profile_id = current_request.owner_profile_id then
    if next_status not in ('accepted', 'declined', 'countered') then
      raise exception 'That response is not available to the listing owner.';
    end if;
    if current_request.status not in ('pending', 'countered') then
      raise exception 'This campaign request can no longer be changed.';
    end if;
    if next_status = 'countered'
      and (proposed_budget is null or proposed_budget < 0 or char_length(trim(response_message)) < 10) then
      raise exception 'A counteroffer needs a valid budget and a short explanation.';
    end if;
  elsif own_profile_id = current_request.requester_profile_id then
    if not (current_request.status = 'countered' and next_status = 'accepted')
      and next_status <> 'cancelled' then
      raise exception 'That response is not available to the requester.';
    end if;
    if next_status = 'cancelled' and current_request.status not in ('pending', 'countered') then
      raise exception 'This campaign request can no longer be cancelled.';
    end if;
  else
    raise exception 'You are not part of this campaign request.';
  end if;

  update public.campaign_requests
  set
    status = next_status,
    counter_budget = case when next_status = 'countered' then proposed_budget else counter_budget end,
    counter_message = case when next_status = 'countered' then trim(response_message) else counter_message end
  where id = request_id
  returning * into current_request;

  return current_request;
end;
$$;

alter table public.campaign_requests enable row level security;
alter table public.verification_requests enable row level security;
alter table public.profile_reports enable row level security;
alter table public.profile_blocks enable row level security;

drop policy if exists "Campaign participants read requests" on public.campaign_requests;
create policy "Campaign participants read requests"
on public.campaign_requests for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.auth_user_id = auth.uid()
      and profiles.id in (
        campaign_requests.requester_profile_id,
        campaign_requests.owner_profile_id
      )
  )
);

drop policy if exists "Members create campaign requests" on public.campaign_requests;
create policy "Members create campaign requests"
on public.campaign_requests for insert
to authenticated
with check (
  requester_profile_id <> owner_profile_id
  and exists (
    select 1 from public.profiles
    where profiles.id = campaign_requests.requester_profile_id
      and profiles.auth_user_id = auth.uid()
      and profiles.onboarding_complete
  )
  and exists (
    select 1 from public.listings
    where listings.id = campaign_requests.listing_id
      and listings.owner_profile_id = campaign_requests.owner_profile_id
      and listings.status = 'active'
  )
);

drop policy if exists "Members read their verification request" on public.verification_requests;
create policy "Members read their verification request"
on public.verification_requests for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = verification_requests.profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "Members submit their verification request" on public.verification_requests;
create policy "Members submit their verification request"
on public.verification_requests for insert
to authenticated
with check (
  status = 'pending'
  and exists (
    select 1 from public.profiles
    where profiles.id = verification_requests.profile_id
      and profiles.auth_user_id = auth.uid()
      and profiles.onboarding_complete
      and profiles.role <> 'consumer'
  )
);

drop policy if exists "Members submit profile reports" on public.profile_reports;
create policy "Members submit profile reports"
on public.profile_reports for insert
to authenticated
with check (
  status = 'open'
  and exists (
    select 1 from public.profiles
    where profiles.id = profile_reports.reporter_profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "Members read their submitted reports" on public.profile_reports;
create policy "Members read their submitted reports"
on public.profile_reports for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = profile_reports.reporter_profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "Members read their blocks" on public.profile_blocks;
create policy "Members read their blocks"
on public.profile_blocks for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = profile_blocks.blocker_profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "Members block profiles" on public.profile_blocks;
create policy "Members block profiles"
on public.profile_blocks for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = profile_blocks.blocker_profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "Members remove their blocks" on public.profile_blocks;
create policy "Members remove their blocks"
on public.profile_blocks for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = profile_blocks.blocker_profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

grant select, insert on public.campaign_requests to authenticated;
grant select, insert on public.verification_requests to authenticated;
grant select, insert on public.profile_reports to authenticated;
grant select, insert, delete on public.profile_blocks to authenticated;
grant execute on function public.respond_campaign_request(uuid, text, integer, text)
  to authenticated;
