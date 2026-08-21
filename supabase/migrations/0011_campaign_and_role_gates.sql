-- Two authorization rules the product states but only the browser enforced.
--
-- 1. A listing owner could accept their own counteroffer. The owner branch of
--    respond_campaign_request allowed next_status='accepted' from either
--    'pending' or 'countered', and the UPDATE preserves counter_budget on any
--    non-'countered' transition, so the row committed as accepted at the
--    owner's own price. status='countered' can only ever have been set by the
--    owner (the requester branch cannot reach it), so accepting from that
--    state has no legitimate use - it binds the requester to a number they
--    never agreed to, and both cards then read "Agreed at $500". The client
--    already hid the button and said why in a comment; the server did not care.
--
-- 2. A member who switched to the consumer role could still republish a paused
--    listing. Creating one requires role <> 'consumer' in the INSERT policy,
--    but the UPDATE policy checked ownership only, so the pause/resume toggle
--    walked straight past the gate. Existing listings also stayed live through
--    the switch, leaving bookable placements attributed to a "Campaign shopper"
--    whose own profile refuses to publish listings.
--
-- Idempotent, so re-applying is a no-op.

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
  where auth_user_id = (select auth.uid())
  limit 1;

  if own_profile_id is null then
    raise exception 'You need a profile to respond to a campaign request.';
  end if;

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
    -- Only the requester may accept a counteroffer. Reaching 'countered'
    -- means this owner named a new price; accepting it themselves would
    -- commit the requester to a number they never saw.
    if next_status = 'accepted' and current_request.status <> 'pending' then
      raise exception 'Only the requester can accept a counteroffer.';
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

-- Publishing and re-publishing must answer to the same role rule.
drop policy if exists "Members update their own listings" on public.listings;
create policy "Members update their own listings"
on public.listings for update to authenticated
using (exists (select 1 from public.profiles
  where profiles.id = listings.owner_profile_id
    and profiles.auth_user_id = (select auth.uid())))
with check (exists (select 1 from public.profiles
  where profiles.id = listings.owner_profile_id
    and profiles.auth_user_id = (select auth.uid())
    -- Pausing stays available to everyone; only going live is gated.
    and (listings.status <> 'active' or profiles.role <> 'consumer')));

-- A role switch must not leave bookable placements behind, attributed to an
-- account the product will not let publish.
create or replace function public.pause_listings_when_role_becomes_consumer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role = 'consumer' and coalesce(old.role, '') <> 'consumer' then
    update public.listings
    set status = 'paused'
    where owner_profile_id = new.id
      and status = 'active';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_pause_listings_on_consumer on public.profiles;
create trigger profiles_pause_listings_on_consumer
  after update of role on public.profiles
  for each row execute function public.pause_listings_when_role_becomes_consumer();
