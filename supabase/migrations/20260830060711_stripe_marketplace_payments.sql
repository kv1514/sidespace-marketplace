-- SideSpace marketplace payments.
--
-- Monetary values are stored as integer cents. Stripe objects are created by
-- server routes only; browser roles can never write payment or account state.

-- Convert the pre-payment catalog from whole dollars to cents. The rename is
-- intentionally explicit so future code cannot silently mix the two units.
-- PostgreSQL will not alter a column's type while an RLS policy depends on it.
-- These are recreated below with the cents column name after the conversion.
drop policy if exists "Requester links conversation" on public.campaign_requests;
drop policy if exists "Members create campaign requests" on public.campaign_requests;

alter table public.listings
  alter column price type bigint using price::bigint * 100,
  alter column price_max type bigint using price_max::bigint * 100;
alter table public.listings rename column price to price_cents;
alter table public.listings rename column price_max to price_max_cents;

alter table public.campaign_requests
  alter column budget type bigint using budget::bigint * 100,
  alter column counter_budget type bigint using counter_budget::bigint * 100;
alter table public.campaign_requests rename column budget to budget_cents;
alter table public.campaign_requests rename column counter_budget to counter_budget_cents;

alter table public.campaign_requests
  add column if not exists accepted_subtotal_cents bigint,
  add column if not exists payer_profile_id uuid
    references public.profiles(id) on delete restrict,
  add column if not exists payee_profile_id uuid
    references public.profiles(id) on delete restrict;

update public.campaign_requests
set accepted_subtotal_cents = coalesce(counter_budget_cents, budget_cents)
where status in ('accepted', 'completed')
  and accepted_subtotal_cents is null;

update public.campaign_requests request
set
  payer_profile_id = case
    when listing.channel = 'Business brief' then request.owner_profile_id
    else request.requester_profile_id
  end,
  payee_profile_id = case
    when listing.channel = 'Business brief' then request.requester_profile_id
    else request.owner_profile_id
  end
from public.listings listing
where listing.id = request.listing_id
  and request.status in ('accepted', 'completed')
  and request.payer_profile_id is null;

alter table public.campaign_requests
  drop constraint if exists campaign_requests_status_check,
  add constraint campaign_requests_status_check
    check (status in (
      'pending', 'accepted', 'confirmed', 'declined', 'countered',
      'cancelled', 'completed', 'refunded', 'disputed'
    )),
  add constraint campaign_requests_accepted_subtotal_valid
    check (accepted_subtotal_cents is null or accepted_subtotal_cents > 0),
  add constraint campaign_requests_payment_parties_valid check (
    (payer_profile_id is null and payee_profile_id is null)
    or (
      payer_profile_id is not null
      and payee_profile_id is not null
      and payer_profile_id <> payee_profile_id
    )
  );

create index campaign_requests_payer_idx
  on public.campaign_requests (payer_profile_id, updated_at desc)
  where payer_profile_id is not null;
create index campaign_requests_payee_idx
  on public.campaign_requests (payee_profile_id, updated_at desc)
  where payee_profile_id is not null;

-- Recreate the campaign response function with cents and snapshot the agreed
-- amount exactly once when both parties accept the terms. Stripe checkout
-- reads this trusted snapshot rather than any browser-submitted amount.
drop function if exists public.respond_campaign_request(uuid, text, integer, text);

create function public.respond_campaign_request(
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
  where id = request_id;

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

-- Migration 0013 pins the mutable campaign columns by name. Recreate both
-- campaign-request policies after the cents rename.
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
  )
);

create policy "Requester links conversation"
on public.campaign_requests for update to authenticated
using (
  conversation_id is null
  and exists (
    select 1 from public.profiles
    where profiles.id = campaign_requests.requester_profile_id
      and profiles.auth_user_id = (select auth.uid())
  )
)
with check (
  conversation_id is not null
  and exists (
    select 1 from public.profiles
    where profiles.id = campaign_requests.requester_profile_id
      and profiles.auth_user_id = (select auth.uid())
  )
  and status = 'pending'
  and counter_budget_cents is null
  and counter_message = ''
  and accepted_subtotal_cents is null
  and payer_profile_id is null
  and payee_profile_id is null
  and exists (
    select 1
    from public.conversations c
    join public.profiles p on p.auth_user_id = (select auth.uid())
    where c.id = campaign_requests.conversation_id
      and p.id in (c.participant_a, c.participant_b)
  )
);

create table public.stripe_accounts (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_connected_account_id text unique,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  requirements_due text[] not null default '{}',
  onboarding_started_at timestamptz,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  campaign_request_id uuid not null unique
    references public.campaign_requests(id) on delete restrict,
  listing_id uuid not null references public.listings(id) on delete restrict,
  business_profile_id uuid not null references public.profiles(id) on delete restrict,
  creator_profile_id uuid not null references public.profiles(id) on delete restrict,
  campaign_name text not null,
  listing_title text not null,
  business_name text not null,
  creator_name text not null,
  currency text not null default 'usd' check (currency = lower(currency)),
  subtotal_cents bigint not null check (subtotal_cents > 0),
  buyer_fee_cents bigint not null check (buyer_fee_cents >= 0),
  creator_fee_cents bigint not null check (creator_fee_cents >= 0),
  customer_total_cents bigint not null check (customer_total_cents > 0),
  creator_payout_cents bigint not null check (creator_payout_cents >= 0),
  platform_gross_revenue_cents bigint not null check (platform_gross_revenue_cents >= 0),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  tax_withheld_cents bigint not null default 0 check (tax_withheld_cents >= 0),
  refunded_cents bigint not null default 0 check (refunded_cents >= 0),
  status text not null default 'requires_checkout'
    check (status in (
      'requires_checkout', 'checkout_open', 'processing', 'paid',
      'payment_failed', 'expired', 'partially_refunded', 'refunded',
      'disputed', 'canceled'
    )),
  checkout_attempt integer not null default 0 check (checkout_attempt >= 0),
  stripe_connected_account_id text not null,
  stripe_customer_id text,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  stripe_charge_id text unique,
  stripe_transfer_id text,
  stripe_tax_transfer_reversal_id text unique,
  stripe_application_fee_id text,
  stripe_invoice_id text,
  dispute_status text,
  checkout_expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_transaction_party_difference
    check (business_profile_id <> creator_profile_id),
  constraint payment_transaction_fee_math check (
    customer_total_cents = subtotal_cents + buyer_fee_cents
    and creator_payout_cents = subtotal_cents - creator_fee_cents
    and platform_gross_revenue_cents = buyer_fee_cents + creator_fee_cents
  ),
  constraint payment_transaction_refund_bound
    check (refunded_cents <= customer_total_cents + tax_cents)
);

create index payment_transactions_business_created_idx
  on public.payment_transactions (business_profile_id, created_at desc);
create index payment_transactions_creator_created_idx
  on public.payment_transactions (creator_profile_id, created_at desc);
create index payment_transactions_status_created_idx
  on public.payment_transactions (status, created_at desc);
create index payment_transactions_payment_intent_idx
  on public.payment_transactions (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
create index payment_transactions_charge_idx
  on public.payment_transactions (stripe_charge_id)
  where stripe_charge_id is not null;

create table public.payment_refunds (
  stripe_refund_id text primary key,
  transaction_id uuid not null
    references public.payment_transactions(id) on delete restrict,
  amount_cents bigint not null check (amount_cents > 0),
  status text not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payment_refunds_transaction_idx
  on public.payment_refunds (transaction_id, created_at desc);

create table public.payment_disputes (
  stripe_dispute_id text primary key,
  transaction_id uuid not null
    references public.payment_transactions(id) on delete restrict,
  amount_cents bigint not null check (amount_cents > 0),
  status text not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payment_disputes_transaction_idx
  on public.payment_disputes (transaction_id, created_at desc);

create table public.stripe_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  livemode boolean not null,
  status text not null default 'processing'
    check (status in ('processing', 'processed', 'failed')),
  attempts integer not null default 1 check (attempts > 0),
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

drop trigger if exists stripe_accounts_set_updated_at on public.stripe_accounts;
create trigger stripe_accounts_set_updated_at
before update on public.stripe_accounts
for each row execute function public.set_updated_at();

drop trigger if exists payment_transactions_set_updated_at on public.payment_transactions;
create trigger payment_transactions_set_updated_at
before update on public.payment_transactions
for each row execute function public.set_updated_at();

drop trigger if exists payment_refunds_set_updated_at on public.payment_refunds;
create trigger payment_refunds_set_updated_at
before update on public.payment_refunds
for each row execute function public.set_updated_at();

drop trigger if exists payment_disputes_set_updated_at on public.payment_disputes;
create trigger payment_disputes_set_updated_at
before update on public.payment_disputes
for each row execute function public.set_updated_at();

alter table public.stripe_accounts enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.payment_refunds enable row level security;
alter table public.payment_disputes enable row level security;
alter table public.stripe_webhook_events enable row level security;

create policy "Participants read payment transactions"
on public.payment_transactions for select to authenticated
using (exists (
  select 1 from public.profiles
  where profiles.auth_user_id = (select auth.uid())
    and profiles.id in (
      payment_transactions.business_profile_id,
      payment_transactions.creator_profile_id
    )
));

create policy "Participants read payment refunds"
on public.payment_refunds for select to authenticated
using (exists (
  select 1
  from public.payment_transactions transaction
  join public.profiles profile
    on profile.id in (transaction.business_profile_id, transaction.creator_profile_id)
  where transaction.id = payment_refunds.transaction_id
    and profile.auth_user_id = (select auth.uid())
));

create policy "Participants read payment disputes"
on public.payment_disputes for select to authenticated
using (exists (
  select 1
  from public.payment_transactions transaction
  join public.profiles profile
    on profile.id in (transaction.business_profile_id, transaction.creator_profile_id)
  where transaction.id = payment_disputes.transaction_id
    and profile.auth_user_id = (select auth.uid())
));

-- All payment tables are accessed through authenticated server routes. This
-- prevents column-level leakage of Stripe IDs while RLS remains a second line
-- of defence if a direct read grant is added later.
revoke all on public.stripe_accounts from public, anon, authenticated;
revoke all on public.payment_transactions from public, anon, authenticated;
revoke all on public.payment_refunds from public, anon, authenticated;
revoke all on public.payment_disputes from public, anon, authenticated;
revoke all on public.stripe_webhook_events from public, anon, authenticated;

grant all on public.stripe_accounts to service_role;
grant all on public.payment_transactions to service_role;
grant all on public.payment_refunds to service_role;
grant all on public.payment_disputes to service_role;
grant all on public.stripe_webhook_events to service_role;

comment on table public.payment_transactions is
  'Authoritative immutable-at-checkout marketplace money snapshot. Stripe '
  'webhooks advance status; browser redirects never fulfil campaigns.';
comment on column public.campaign_requests.accepted_subtotal_cents is
  'Agreed campaign subtotal snapshotted when terms are accepted. Checkout '
  'never accepts an amount from the browser.';
