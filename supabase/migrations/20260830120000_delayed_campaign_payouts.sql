-- Delayed Creator payouts, delivery review, issue handling, and immutable
-- financial state transitions. Customer charges stay on the SideSpace
-- platform until one of the release functions authorizes a Connect transfer.

alter table public.payment_transactions
  add column if not exists workflow_status text not null default 'requires_checkout',
  add column if not exists payout_status text not null default 'not_ready',
  add column if not exists payout_amount_cents bigint,
  add column if not exists delivered_at timestamptz,
  add column if not exists review_deadline timestamptz,
  add column if not exists confirmed_at timestamptz,
  add column if not exists issue_reported_at timestamptz,
  add column if not exists issue_status text not null default 'none',
  add column if not exists escalated_at timestamptz,
  add column if not exists payout_release_claimed_at timestamptz,
  add column if not exists payout_released_at timestamptz,
  add column if not exists payout_release_reason text,
  add column if not exists payout_last_error text,
  add column if not exists stripe_transfer_reversal_id text;

update public.payment_transactions
set
  payout_amount_cents = creator_payout_cents,
  payout_status = case
    when stripe_transfer_id is not null then 'released'
    when status = 'refunded' then 'refunded'
    when status = 'partially_refunded' then 'partially_refunded'
    when status = 'disputed' then 'disputed'
    when status = 'paid' then 'pending'
    else 'not_ready'
  end,
  workflow_status = case
    -- Legacy destination charges already moved Creator funds at payment time.
    -- Mark them released so this migration can never send a second transfer.
    when stripe_transfer_id is not null then 'completed'
    when status = 'refunded' then 'refunded'
    when status = 'partially_refunded' then 'partially_refunded'
    when status = 'disputed' then 'disputed'
    when status = 'paid' then 'paid_payout_pending'
    else status
  end,
  payout_released_at = case
    when stripe_transfer_id is not null then coalesce(payout_released_at, paid_at, updated_at)
    else payout_released_at
  end
where payout_amount_cents is null
   or payout_status = 'not_ready'
   or workflow_status = 'requires_checkout';

alter table public.payment_transactions
  alter column payout_amount_cents set not null,
  add constraint payment_transactions_payout_amount_valid
    check (payout_amount_cents between 0 and creator_payout_cents),
  add constraint payment_transactions_workflow_status_valid
    check (workflow_status in (
      'requires_checkout', 'checkout_open', 'processing',
      'paid_payout_pending', 'awaiting_payer_review', 'issue_open',
      'issue_escalated', 'refund_pending', 'payout_released', 'completed',
      'payment_failed', 'expired', 'partially_refunded', 'refunded',
      'disputed', 'canceled'
    )),
  add constraint payment_transactions_payout_status_valid
    check (payout_status in (
      'not_ready', 'pending', 'releasing', 'released', 'blocked',
      'partially_refunded', 'refunded', 'disputed'
    )),
  add constraint payment_transactions_issue_status_valid
    check (issue_status in ('none', 'open', 'escalated', 'resolution_pending', 'resolved')),
  add constraint payment_transactions_review_window_valid check (
    (delivered_at is null and review_deadline is null)
    or review_deadline = delivered_at + interval '72 hours'
  ),
  add constraint payment_transactions_release_timestamp_valid check (
    (payout_status = 'released' and payout_released_at is not null)
    or payout_status <> 'released'
  );

create unique index if not exists payment_transactions_transfer_unique_idx
  on public.payment_transactions (stripe_transfer_id)
  where stripe_transfer_id is not null;
create unique index if not exists payment_transactions_transfer_reversal_unique_idx
  on public.payment_transactions (stripe_transfer_reversal_id)
  where stripe_transfer_reversal_id is not null;
create index if not exists payment_transactions_auto_release_idx
  on public.payment_transactions (review_deadline)
  where payout_status in ('pending', 'releasing')
    and issue_status = 'none';

create table public.payment_issues (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique
    references public.payment_transactions(id) on delete restrict,
  reported_by_profile_id uuid not null
    references public.profiles(id) on delete restrict,
  details text not null check (char_length(trim(details)) between 10 and 4000),
  status text not null default 'open'
    check (status in ('open', 'escalated', 'resolution_pending', 'resolved')),
  reported_at timestamptz not null default now(),
  resolution_attempted_at timestamptz,
  escalated_at timestamptz,
  resolved_at timestamptz,
  resolution_action text
    check (resolution_action is null or resolution_action in (
      'release_payout', 'full_refund', 'partial_refund'
    )),
  resolution_notes text not null default '' check (char_length(resolution_notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payment_fulfillment_events (
  id bigint generated always as identity primary key,
  transaction_id uuid not null
    references public.payment_transactions(id) on delete restrict,
  actor_profile_id uuid references public.profiles(id) on delete restrict,
  actor_kind text not null check (actor_kind in ('payer', 'payee', 'staff', 'system', 'stripe')),
  event_type text not null,
  from_state text,
  to_state text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index payment_fulfillment_events_transaction_idx
  on public.payment_fulfillment_events (transaction_id, created_at, id);

create table public.payment_resolution_actions (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null unique references public.payment_issues(id) on delete restrict,
  transaction_id uuid not null references public.payment_transactions(id) on delete restrict,
  staff_auth_user_id uuid not null,
  action text not null check (action in ('full_refund', 'partial_refund')),
  refund_amount_cents bigint not null check (refund_amount_cents > 0),
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  idempotency_key text not null unique,
  stripe_refund_id text unique,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.staff_members (
  auth_user_id uuid primary key,
  role text not null default 'support'
    check (role in ('support', 'payments_admin', 'admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

drop trigger if exists payment_issues_set_updated_at on public.payment_issues;
create trigger payment_issues_set_updated_at
before update on public.payment_issues
for each row execute function public.set_updated_at();

alter table public.payment_issues enable row level security;
alter table public.payment_fulfillment_events enable row level security;
alter table public.payment_resolution_actions enable row level security;
alter table public.staff_members enable row level security;

create or replace function private.reject_immutable_financial_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Payment fulfillment events are append-only.';
end;
$$;

drop trigger if exists payment_fulfillment_events_immutable
  on public.payment_fulfillment_events;
create trigger payment_fulfillment_events_immutable
before update or delete on public.payment_fulfillment_events
for each row execute function private.reject_immutable_financial_event_mutation();

revoke all on public.payment_issues from public, anon, authenticated;
revoke all on public.payment_fulfillment_events from public, anon, authenticated;
revoke all on public.payment_resolution_actions from public, anon, authenticated;
revoke all on public.staff_members from public, anon, authenticated;
grant all on public.payment_issues to service_role;
grant all on public.payment_fulfillment_events to service_role;
grant all on public.payment_resolution_actions to service_role;
grant all on public.staff_members to service_role;
grant usage, select on sequence public.payment_fulfillment_events_id_seq to service_role;

create or replace function private.protect_paid_campaign_terms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.payment_transactions transaction
    where transaction.campaign_request_id = old.id
      and transaction.paid_at is not null
  ) and (
    new.listing_id is distinct from old.listing_id
    or new.requester_profile_id is distinct from old.requester_profile_id
    or new.owner_profile_id is distinct from old.owner_profile_id
    or new.campaign_name is distinct from old.campaign_name
    or new.requested_deliverables is distinct from old.requested_deliverables
    or new.budget_cents is distinct from old.budget_cents
    or new.counter_budget_cents is distinct from old.counter_budget_cents
    or new.accepted_subtotal_cents is distinct from old.accepted_subtotal_cents
    or new.start_date is distinct from old.start_date
    or new.end_date is distinct from old.end_date
    or new.payer_profile_id is distinct from old.payer_profile_id
    or new.payee_profile_id is distinct from old.payee_profile_id
  ) then
    raise exception 'Paid campaign terms are immutable.';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_paid_campaign_terms on public.campaign_requests;
create trigger protect_paid_campaign_terms
before update on public.campaign_requests
for each row execute function private.protect_paid_campaign_terms();

create or replace function private.protect_payment_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.paid_at is not null and (
    new.campaign_request_id is distinct from old.campaign_request_id
    or new.listing_id is distinct from old.listing_id
    or new.business_profile_id is distinct from old.business_profile_id
    or new.creator_profile_id is distinct from old.creator_profile_id
    or new.currency is distinct from old.currency
    or new.subtotal_cents is distinct from old.subtotal_cents
    or new.buyer_fee_cents is distinct from old.buyer_fee_cents
    or new.creator_fee_cents is distinct from old.creator_fee_cents
    or new.customer_total_cents is distinct from old.customer_total_cents
    or new.creator_payout_cents is distinct from old.creator_payout_cents
    or new.platform_gross_revenue_cents is distinct from old.platform_gross_revenue_cents
    or new.stripe_connected_account_id is distinct from old.stripe_connected_account_id
  ) then
    raise exception 'Paid transaction snapshots are immutable.';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_payment_snapshot on public.payment_transactions;
create trigger protect_payment_snapshot
before update on public.payment_transactions
for each row execute function private.protect_payment_snapshot();

create or replace function public.mark_campaign_delivered(
  target_transaction_id uuid,
  actor_profile_id uuid
)
returns public.payment_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction public.payment_transactions;
  transition_at timestamptz := clock_timestamp();
begin
  select * into transaction
  from public.payment_transactions
  where id = target_transaction_id
  for update;

  if transaction.id is null then raise exception 'Payment transaction not found.'; end if;
  if transaction.creator_profile_id <> actor_profile_id then
    raise exception 'Only the Creator receiving this payout can mark delivery.';
  end if;
  if transaction.status not in ('paid', 'partially_refunded') or transaction.paid_at is null then
    raise exception 'Payment must be verified before delivery.';
  end if;
  if transaction.delivered_at is not null then return transaction; end if;
  if transaction.payout_status <> 'pending' or transaction.workflow_status <> 'paid_payout_pending' then
    raise exception 'This campaign cannot be marked delivered in its current state.';
  end if;

  update public.payment_transactions
  set delivered_at = transition_at,
      review_deadline = transition_at + interval '72 hours',
      workflow_status = 'awaiting_payer_review'
  where id = transaction.id
  returning * into transaction;

  insert into public.payment_fulfillment_events (
    transaction_id, actor_profile_id, actor_kind, event_type, from_state, to_state
  ) values (
    transaction.id, actor_profile_id, 'payee', 'campaign_delivered',
    'paid_payout_pending', 'awaiting_payer_review'
  );
  return transaction;
end;
$$;

create or replace function public.report_campaign_issue(
  target_transaction_id uuid,
  actor_profile_id uuid,
  issue_details text
)
returns public.payment_issues
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction public.payment_transactions;
  issue public.payment_issues;
  transition_at timestamptz := clock_timestamp();
begin
  select * into transaction from public.payment_transactions
  where id = target_transaction_id for update;
  if transaction.id is null then raise exception 'Payment transaction not found.'; end if;
  if transaction.business_profile_id <> actor_profile_id then
    raise exception 'Only the payer can report an issue.';
  end if;

  select * into issue from public.payment_issues
  where transaction_id = transaction.id;
  if issue.id is not null then return issue; end if;
  if transaction.workflow_status <> 'awaiting_payer_review'
     or transaction.payout_status <> 'pending'
     or transaction.review_deadline is null
     or transition_at >= transaction.review_deadline then
    raise exception 'The review period has ended or this campaign is already complete.';
  end if;

  insert into public.payment_issues (transaction_id, reported_by_profile_id, details, reported_at)
  values (transaction.id, actor_profile_id, trim(issue_details), transition_at)
  returning * into issue;

  update public.payment_transactions
  set issue_reported_at = transition_at,
      issue_status = 'open',
      payout_status = 'blocked',
      workflow_status = 'issue_open'
  where id = transaction.id;

  insert into public.payment_fulfillment_events (
    transaction_id, actor_profile_id, actor_kind, event_type, from_state, to_state
  ) values (
    transaction.id, actor_profile_id, 'payer', 'issue_reported',
    'awaiting_payer_review', 'issue_open'
  );
  return issue;
end;
$$;

create or replace function public.escalate_campaign_issue(
  target_transaction_id uuid,
  actor_profile_id uuid
)
returns public.payment_issues
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction public.payment_transactions;
  issue public.payment_issues;
  v_conversation_id uuid;
  transition_at timestamptz := clock_timestamp();
begin
  select * into transaction from public.payment_transactions
  where id = target_transaction_id for update;
  if transaction.id is null then raise exception 'Payment transaction not found.'; end if;
  if transaction.business_profile_id <> actor_profile_id then
    raise exception 'Only the payer can escalate this issue.';
  end if;
  select * into issue from public.payment_issues
  where transaction_id = transaction.id for update;
  if issue.id is null then raise exception 'Report an issue before escalating it.'; end if;
  if issue.status in ('escalated', 'resolution_pending', 'resolved') then return issue; end if;

  select request.conversation_id into v_conversation_id
  from public.campaign_requests request
  where request.id = transaction.campaign_request_id;
  if v_conversation_id is null
     or not exists (
       select 1 from public.messages message
       where message.conversation_id = v_conversation_id
         and message.sender_profile_id = transaction.business_profile_id
         and message.created_at >= issue.reported_at
     )
     or not exists (
       select 1 from public.messages message
       where message.conversation_id = v_conversation_id
         and message.sender_profile_id = transaction.creator_profile_id
         and message.created_at >= issue.reported_at
     ) then
    raise exception 'Resolve with the Creator in Messages before escalating to SideSpace.';
  end if;

  update public.payment_issues
  set status = 'escalated', resolution_attempted_at = transition_at,
      escalated_at = transition_at
  where id = issue.id returning * into issue;
  update public.payment_transactions
  set issue_status = 'escalated', escalated_at = transition_at,
      workflow_status = 'issue_escalated'
  where id = transaction.id;
  insert into public.payment_fulfillment_events (
    transaction_id, actor_profile_id, actor_kind, event_type, from_state, to_state
  ) values (
    transaction.id, actor_profile_id, 'payer', 'issue_escalated',
    'issue_open', 'issue_escalated'
  );
  return issue;
end;
$$;

create or replace function public.claim_campaign_payout_release(
  target_transaction_id uuid,
  release_mode text,
  actor_profile_id uuid default null,
  staff_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction public.payment_transactions;
  transition_at timestamptz := clock_timestamp();
  from_state text;
begin
  select * into transaction from public.payment_transactions
  where id = target_transaction_id for update;
  if transaction.id is null then raise exception 'Payment transaction not found.'; end if;

  -- Authorize before any idempotent early return. Duplicate clicks are safe,
  -- but they must not turn into a way for a non-party to confirm or inspect a
  -- release that another actor already claimed.
  if release_mode = 'payer_confirmation'
     and transaction.business_profile_id <> actor_profile_id then
    raise exception 'Only the payer can confirm completion.';
  elsif release_mode = 'staff' and not exists (
    select 1 from public.staff_members staff
    where staff.auth_user_id = staff_user_id and staff.active
      and staff.role in ('payments_admin', 'admin')
  ) then
    raise exception 'Payments staff authorization is required.';
  elsif release_mode = 'partial_refund_resolution' and not exists (
    select 1 from public.payment_resolution_actions resolution
    where resolution.transaction_id = transaction.id
      and resolution.action = 'partial_refund'
      and resolution.status = 'completed'
  ) then
    raise exception 'The partial refund must complete before payout release.';
  elsif release_mode not in (
    'payer_confirmation', 'automatic', 'staff', 'partial_refund_resolution'
  ) then
    raise exception 'Unknown payout release mode.';
  end if;
  if transaction.payout_status = 'released' then
    return jsonb_build_object('already_released', true, 'transaction', to_jsonb(transaction));
  end if;
  if transaction.payout_status = 'releasing' then
    return jsonb_build_object('already_released', false, 'should_transfer', true, 'transaction', to_jsonb(transaction));
  end if;

  if release_mode = 'payer_confirmation' then
    if transaction.workflow_status <> 'awaiting_payer_review'
       or transaction.issue_status <> 'none'
       or transaction.review_deadline is null
       or transition_at >= transaction.review_deadline then
      raise exception 'The review period ended or this campaign is no longer awaiting confirmation.';
    end if;
  elsif release_mode = 'automatic' then
    if transaction.workflow_status <> 'awaiting_payer_review'
       or transaction.issue_status <> 'none'
       or transaction.review_deadline is null
       or transition_at < transaction.review_deadline then
      raise exception 'This payout is not due for automatic release.';
    end if;
  elsif release_mode = 'staff' then
    if not exists (
      select 1 from public.staff_members staff
      where staff.auth_user_id = staff_user_id and staff.active
        and staff.role in ('payments_admin', 'admin')
    ) then raise exception 'Payments staff authorization is required.'; end if;
    if transaction.issue_status <> 'escalated'
       or transaction.workflow_status <> 'issue_escalated' then
      raise exception 'Only an escalated issue can be released by staff.';
    end if;
  elsif release_mode = 'partial_refund_resolution' then
    if not exists (
      select 1 from public.payment_resolution_actions resolution
      where resolution.transaction_id = transaction.id
        and resolution.action = 'partial_refund'
        and resolution.status = 'completed'
    ) then raise exception 'The partial refund must complete before payout release.'; end if;
  else
    raise exception 'Unknown payout release mode.';
  end if;

  if transaction.payout_status not in ('pending', 'blocked', 'partially_refunded') then
    raise exception 'This payout is not available for release.';
  end if;
  from_state := transaction.workflow_status;
  update public.payment_transactions
  set payout_status = 'releasing', payout_release_claimed_at = transition_at,
      payout_release_reason = release_mode, payout_last_error = null,
      confirmed_at = case when release_mode = 'payer_confirmation'
        then coalesce(confirmed_at, transition_at) else confirmed_at end,
      issue_status = case when release_mode in ('staff', 'partial_refund_resolution')
        then 'resolution_pending' else issue_status end
  where id = transaction.id returning * into transaction;

  insert into public.payment_fulfillment_events (
    transaction_id, actor_profile_id, actor_kind, event_type, from_state, to_state,
    metadata
  ) values (
    transaction.id, actor_profile_id,
    case when release_mode = 'automatic' then 'system'
         when release_mode in ('staff', 'partial_refund_resolution') then 'staff'
         else 'payer' end,
    'payout_release_claimed', from_state, from_state,
    jsonb_build_object('release_mode', release_mode)
  );
  return jsonb_build_object('already_released', false, 'should_transfer', true, 'transaction', to_jsonb(transaction));
end;
$$;

create or replace function public.finalize_campaign_payout_release(
  target_transaction_id uuid,
  transfer_id text,
  transferred_amount_cents bigint
)
returns public.payment_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction public.payment_transactions;
  transition_at timestamptz := clock_timestamp();
  from_state text;
begin
  select * into transaction from public.payment_transactions
  where id = target_transaction_id for update;
  if transaction.id is null then raise exception 'Payment transaction not found.'; end if;
  if transaction.payout_status = 'released' then
    if transaction.stripe_transfer_id <> transfer_id then
      raise exception 'A different transfer already released this payout.';
    end if;
    return transaction;
  end if;
  if transaction.payout_status <> 'releasing' then
    raise exception 'The payout must be claimed before it can be finalized.';
  end if;
  if transaction.payout_amount_cents <> transferred_amount_cents then
    raise exception 'The Stripe transfer amount does not match the trusted ledger.';
  end if;
  from_state := transaction.workflow_status;
  update public.payment_transactions
  set payout_status = 'released', stripe_transfer_id = transfer_id,
      payout_released_at = transition_at, workflow_status = 'completed',
      issue_status = case when issue_status = 'none' then 'none' else 'resolved' end,
      payout_last_error = null
  where id = transaction.id returning * into transaction;
  update public.campaign_requests set status = 'completed'
  where id = transaction.campaign_request_id;
  update public.payment_issues
  set status = 'resolved', resolved_at = transition_at,
      resolution_action = coalesce(resolution_action, 'release_payout')
  where transaction_id = transaction.id and status <> 'resolved';
  insert into public.payment_fulfillment_events (
    transaction_id, actor_kind, event_type, from_state, to_state,
    metadata
  ) values (
    transaction.id, 'stripe', 'payout_released', from_state, 'completed',
    jsonb_build_object('stripe_transfer_id', transfer_id, 'amount_cents', transferred_amount_cents)
  );
  return transaction;
end;
$$;

create or replace function public.record_campaign_payout_release_failure(
  target_transaction_id uuid,
  error_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.payment_transactions
  set payout_status = case when issue_status = 'none' then 'pending' else 'blocked' end,
      payout_last_error = left(error_message, 1000)
  where id = target_transaction_id and payout_status = 'releasing';
end;
$$;

create or replace function public.claim_issue_refund_resolution(
  target_issue_id uuid,
  staff_user_id uuid,
  requested_action text,
  requested_refund_cents bigint default null,
  notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  issue public.payment_issues;
  transaction public.payment_transactions;
  resolution public.payment_resolution_actions;
  total_charge bigint;
  remaining_charge bigint;
  refund_amount bigint;
  adjusted_payout bigint;
begin
  if not exists (
    select 1 from public.staff_members staff
    where staff.auth_user_id = staff_user_id and staff.active
      and staff.role in ('payments_admin', 'admin')
  ) then raise exception 'Payments staff authorization is required.'; end if;
  if requested_action not in ('full_refund', 'partial_refund') then
    raise exception 'Choose a supported refund resolution.';
  end if;
  select * into issue from public.payment_issues where id = target_issue_id for update;
  if issue.id is null then raise exception 'Payment issue not found.'; end if;
  select * into transaction from public.payment_transactions
  where id = issue.transaction_id for update;
  select * into resolution from public.payment_resolution_actions
  where issue_id = issue.id;
  if resolution.id is not null then
    return jsonb_build_object('duplicate', true, 'resolution', to_jsonb(resolution), 'transaction', to_jsonb(transaction));
  end if;
  if issue.status <> 'escalated' or transaction.payout_status <> 'blocked' then
    raise exception 'Only an escalated issue with a pending payout can be refunded.';
  end if;
  if transaction.stripe_charge_id is null then raise exception 'The verified Stripe charge is missing.'; end if;
  total_charge := transaction.customer_total_cents + transaction.tax_cents;
  remaining_charge := total_charge - transaction.refunded_cents;
  refund_amount := case when requested_action = 'full_refund'
    then remaining_charge else requested_refund_cents end;
  if refund_amount is null or refund_amount <= 0 or refund_amount > remaining_charge then
    raise exception 'Refund amount is outside the remaining customer charge.';
  end if;
  if requested_action = 'partial_refund' and refund_amount >= remaining_charge then
    raise exception 'Use full refund when returning the entire remaining charge.';
  end if;
  adjusted_payout := greatest(1, floor(
    transaction.creator_payout_cents::numeric
    * (total_charge - transaction.refunded_cents - refund_amount)::numeric
    / nullif(total_charge, 0)::numeric
  )::bigint);

  insert into public.payment_resolution_actions (
    issue_id, transaction_id, staff_auth_user_id, action, refund_amount_cents,
    idempotency_key
  ) values (
    issue.id, transaction.id, staff_user_id, requested_action, refund_amount,
    'sidespace-issue-refund-' || issue.id::text
  ) returning * into resolution;
  update public.payment_issues
  set status = 'resolution_pending', resolution_action = requested_action,
      resolution_notes = trim(notes)
  where id = issue.id;
  update public.payment_transactions
  set issue_status = 'resolution_pending', workflow_status = 'refund_pending',
      payout_status = 'blocked',
      payout_amount_cents = case when requested_action = 'partial_refund'
        then adjusted_payout else 0 end
  where id = transaction.id returning * into transaction;
  return jsonb_build_object('duplicate', false, 'resolution', to_jsonb(resolution), 'transaction', to_jsonb(transaction));
end;
$$;

revoke all on function public.mark_campaign_delivered(uuid, uuid) from public, anon, authenticated;
revoke all on function public.report_campaign_issue(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.escalate_campaign_issue(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_campaign_payout_release(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.finalize_campaign_payout_release(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.record_campaign_payout_release_failure(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_issue_refund_resolution(uuid, uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.mark_campaign_delivered(uuid, uuid) to service_role;
grant execute on function public.report_campaign_issue(uuid, uuid, text) to service_role;
grant execute on function public.escalate_campaign_issue(uuid, uuid) to service_role;
grant execute on function public.claim_campaign_payout_release(uuid, text, uuid, uuid) to service_role;
grant execute on function public.finalize_campaign_payout_release(uuid, text, bigint) to service_role;
grant execute on function public.record_campaign_payout_release_failure(uuid, text) to service_role;
grant execute on function public.claim_issue_refund_resolution(uuid, uuid, text, bigint, text) to service_role;

comment on column public.payment_transactions.payout_status is
  'Creator payout lifecycle, separate from the customer charge status.';
comment on column public.payment_transactions.review_deadline is
  'Exactly 72 hours after delivered_at; server release code must not run before it.';
comment on table public.payment_fulfillment_events is
  'Append-only audit history for delivery, review, issue, refund, and payout transitions.';
