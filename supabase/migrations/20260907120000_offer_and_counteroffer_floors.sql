-- Floors for what either side may put on the table.
--
-- A negotiation here is two numbers passed back and forth: a member offers,
-- the owner counters. Neither number was bounded, so a $900 window could be
-- offered $5 and a $2,000 pitch countered at $20. Nothing failed - the other
-- side just got a notification and a decision to make about an amount nobody
-- meant seriously, which is the cheapest way to make a marketplace this size
-- feel worthless to the people supplying it.
--
-- Two rules, matching lib/payments/offer-floor.ts cent for cent:
--
--   * A proposition may not undercut the amount already on the table by more
--     than 60%. The reference is always what the OTHER side last put up - the
--     listed price for a first offer, the member's budget for a counteroffer.
--     Anchoring a revised counteroffer to the owner's own earlier one would
--     forbid them from conceding toward the member, which is the direction a
--     revision usually moves.
--   * Nothing may be proposed under $2. Below that the card fee is most of the
--     money and neither side is really transacting.
--
-- Going up is deliberately not capped: asking for more than was offered is an
-- ordinary ask, and the other side can decline it.
--
-- Both checks run in the database because the browser writes campaign requests
-- directly. The matching checks in the client exist to name the wrong number
-- before anyone is notified, not to enforce anything.
--
-- Requests that already exist are left alone. The floor applies to new
-- propositions only, so an offer sent before today can still be accepted,
-- countered above the floor, or declined.

create or replace function private.offer_floor_cents(reference_cents bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$
  -- The 40% share rounds UP: rounding down would let the rounding cent widen
  -- the cut past the 60% the rule allows. Integer division truncates toward
  -- zero, and both operands are non-negative, so + 9999 is a ceiling.
  select greatest(
    200::bigint,
    (greatest(coalesce(reference_cents, 0), 0) * 4000 + 9999) / 10000
  );
$$;

revoke all on function private.offer_floor_cents(bigint) from public, anon, authenticated;

-- Amounts belong in these messages: "offer at least $360" alone reads as an
-- arbitrary rule, and the member cannot tell which number to change.
create or replace function private.money_text(cents bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select '$' || to_char(coalesce(cents, 0) / 100.0, 'FM999,999,999,999,990.00');
$$;

revoke all on function private.money_text(bigint) from public, anon, authenticated;

create or replace function private.enforce_offer_floor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  asking_cents bigint;
  floor_cents bigint;
begin
  -- Book-as-listed is not a proposition. Its amount IS the listing's price,
  -- which the insert policy already matches against the listing itself, so
  -- there is no chosen number here to floor.
  if new.purchase_mode <> 'offer' then
    return new;
  end if;

  select price_cents into asking_cents
  from public.listings
  where id = new.listing_id;

  if asking_cents is null then
    raise exception 'The campaign listing is no longer available.';
  end if;

  if new.budget_cents < 200 then
    raise exception 'Offers start at %.', private.money_text(200);
  end if;

  floor_cents := private.offer_floor_cents(asking_cents);
  if new.budget_cents < floor_cents then
    raise exception
      'An offer cannot be more than 60%% below the % asking price. Offer at least %.',
      private.money_text(asking_cents),
      private.money_text(floor_cents);
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_offer_floor() from public, anon, authenticated;

drop trigger if exists enforce_offer_floor on public.campaign_requests;
create trigger enforce_offer_floor
  before insert on public.campaign_requests
  for each row execute function private.enforce_offer_floor();

-- Same two rules on the reply side. Unchanged from the previous definition
-- apart from the counteroffer floor: the row lock, the status transitions, and
-- the payer/payee snapshot all still work as they did.
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
  counter_floor_cents bigint;
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
    if next_status = 'countered' then
      if proposed_budget_cents is null
        or proposed_budget_cents <= 0
        or char_length(trim(response_message)) < 10 then
        raise exception 'A counteroffer needs a valid budget and a short explanation.';
      end if;
      if proposed_budget_cents < 200 then
        raise exception 'Counteroffers start at %.', private.money_text(200);
      end if;
      -- Against the member's budget, never against a counteroffer already
      -- standing, so an owner may keep conceding toward the member.
      counter_floor_cents := private.offer_floor_cents(current_request.budget_cents);
      if proposed_budget_cents < counter_floor_cents then
        raise exception
          'A counteroffer cannot be more than 60%% below the % on the table. Counter with at least %.',
          private.money_text(current_request.budget_cents),
          private.money_text(counter_floor_cents);
      end if;
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
  from public, anon, service_role;
grant execute on function public.respond_campaign_request(uuid, text, bigint, text)
  to authenticated;
