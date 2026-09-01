-- Serialize campaign responses before calculating the accepted amount and
-- payer/payee snapshot. Without the row lock, two legitimate responses can
-- both validate the same status and then last-write-wins can corrupt terms.
create or replace function public.respond_campaign_request(
  request_id uuid,
  next_status text,
  proposed_budget_cents bigint default null,
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
  listing_channel text;
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
  where id = request_id
  for update;

  if current_request.id is null then
    raise exception 'Campaign request not found.';
  end if;

  select channel into listing_channel
  from public.listings
  where id = current_request.listing_id;

  if listing_channel is null then
    raise exception 'The campaign listing is no longer available.';
  end if;

  if own_profile_id = current_request.owner_profile_id then
    if next_status not in ('accepted', 'declined', 'countered') then
      raise exception 'That response is not available to the listing owner.';
    end if;
    if current_request.status not in ('pending', 'countered') then
      raise exception 'This campaign request can no longer be changed.';
    end if;
    if next_status = 'accepted' and current_request.status <> 'pending' then
      raise exception 'Only the requester can accept a counteroffer.';
    end if;
    if next_status = 'countered' and (
      proposed_budget_cents is null
      or proposed_budget_cents <= 0
      or char_length(trim(response_message)) < 10
    ) then
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
    counter_budget_cents = case
      when next_status = 'countered' then proposed_budget_cents
      else counter_budget_cents
    end,
    counter_message = case
      when next_status = 'countered' then trim(response_message)
      else counter_message
    end,
    accepted_subtotal_cents = case
      when next_status = 'accepted' and current_request.status = 'countered'
        then current_request.counter_budget_cents
      when next_status = 'accepted'
        then current_request.budget_cents
      else accepted_subtotal_cents
    end,
    payer_profile_id = case
      when next_status <> 'accepted' then payer_profile_id
      when listing_channel = 'Business brief' then current_request.owner_profile_id
      else current_request.requester_profile_id
    end,
    payee_profile_id = case
      when next_status <> 'accepted' then payee_profile_id
      when listing_channel = 'Business brief' then current_request.requester_profile_id
      else current_request.owner_profile_id
    end
  where id = request_id
  returning * into current_request;

  return current_request;
end;
$$;

revoke execute on function public.respond_campaign_request(uuid, text, bigint, text)
  from public, anon;
grant execute on function public.respond_campaign_request(uuid, text, bigint, text)
  to authenticated;
