-- Recover Creator transfers when a platform charge is refunded or a dispute
-- is finally lost after payout. Separate charges and transfers do not reverse
-- automatically, so this queue keeps the recovery idempotent and retryable.

alter table public.payment_transactions
  add column if not exists payout_recovery_status text not null default 'not_required',
  add column if not exists payout_recovery_target_cents bigint not null default 0,
  add column if not exists payout_recovery_reversed_cents bigint not null default 0,
  add column if not exists payout_recovery_last_error text;

alter table public.payment_transactions
  add constraint payment_transactions_payout_recovery_status_valid
    check (payout_recovery_status in (
      'not_required', 'pending', 'processing', 'recovered', 'failed'
    )),
  add constraint payment_transactions_payout_recovery_target_valid
    check (payout_recovery_target_cents between 0 and payout_amount_cents),
  add constraint payment_transactions_payout_recovery_reversed_valid
    check (payout_recovery_reversed_cents between 0 and payout_amount_cents);

create table public.payment_transfer_reversals (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null
    references public.payment_transactions(id) on delete restrict,
  stripe_transfer_id text not null,
  target_amount_cents bigint not null check (target_amount_cents > 0),
  reason text not null check (reason in ('refund', 'dispute')),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'succeeded', 'failed')),
  idempotency_key text not null unique,
  stripe_transfer_reversal_id text unique,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_transfer_reversal_target_unique
    unique (transaction_id, target_amount_cents)
);

create index payment_transfer_reversals_retry_idx
  on public.payment_transfer_reversals (status, next_attempt_at)
  where status in ('pending', 'failed');
create index payment_transfer_reversals_transaction_idx
  on public.payment_transfer_reversals (transaction_id, target_amount_cents desc);

drop trigger if exists payment_transfer_reversals_set_updated_at
  on public.payment_transfer_reversals;
create trigger payment_transfer_reversals_set_updated_at
before update on public.payment_transfer_reversals
for each row execute function public.set_updated_at();

alter table public.payment_transfer_reversals enable row level security;
revoke all on public.payment_transfer_reversals from public, anon, authenticated;
grant all on public.payment_transfer_reversals to service_role;

create or replace function public.queue_campaign_transfer_reversal(
  target_transaction_id uuid,
  target_reversal_cents bigint,
  recovery_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction public.payment_transactions;
  reversal public.payment_transfer_reversals;
  transition_at timestamptz := clock_timestamp();
begin
  if target_reversal_cents < 0 then
    raise exception 'The transfer reversal amount cannot be negative.';
  end if;
  if recovery_reason not in ('refund', 'dispute') then
    raise exception 'Unknown transfer recovery reason.';
  end if;

  select * into transaction
  from public.payment_transactions
  where id = target_transaction_id
  for update;
  if transaction.id is null then
    raise exception 'Payment transaction not found.';
  end if;
  if transaction.payout_status <> 'released'
     or transaction.stripe_transfer_id is null
     or transaction.stripe_charge_id is null then
    raise exception 'Only a released payout with verified Stripe transfer data can be recovered.';
  end if;
  if target_reversal_cents > transaction.payout_amount_cents then
    raise exception 'The transfer reversal exceeds the released payout.';
  end if;

  if target_reversal_cents = 0 then
    update public.payment_transactions
    set payout_recovery_status = case
          when payout_recovery_reversed_cents >= payout_recovery_target_cents
            then 'recovered'
          else payout_recovery_status
        end,
        payout_recovery_target_cents = greatest(payout_recovery_target_cents, 0),
        payout_recovery_last_error = null
    where id = transaction.id;
    return jsonb_build_object(
      'should_process', false,
      'busy', false,
      'status', case
        when transaction.payout_recovery_reversed_cents >= transaction.payout_recovery_target_cents
          then 'recovered'
        else transaction.payout_recovery_status
      end,
      'target_amount_cents', 0
    );
  end if;

  update public.payment_transactions
  set payout_recovery_target_cents = greatest(
        payout_recovery_target_cents, target_reversal_cents
      ),
      payout_recovery_status = case
        when payout_recovery_reversed_cents >= greatest(
          payout_recovery_target_cents, target_reversal_cents
        ) then 'recovered'
        else 'pending'
      end,
      payout_recovery_last_error = null
  where id = transaction.id;

  insert into public.payment_transfer_reversals (
    transaction_id, stripe_transfer_id, target_amount_cents, reason,
    idempotency_key
  ) values (
    transaction.id,
    transaction.stripe_transfer_id,
    target_reversal_cents,
    recovery_reason,
    'sidespace-payout-reversal-' || transaction.id::text || '-'
      || target_reversal_cents::text
  )
  on conflict (transaction_id, target_amount_cents) do nothing;

  -- A crashed worker can leave a claim behind after Stripe accepted the
  -- reversal. Reclaim it after the same window used by webhook claims; the
  -- next worker first reads Stripe's amount_reversed before creating anything.
  update public.payment_transfer_reversals
  set status = 'failed', claimed_at = null,
      next_attempt_at = transition_at,
      last_error = coalesce(last_error, 'Stale transfer-reversal claim reclaimed.')
  where transaction_id = transaction.id
    and status = 'processing'
    and (claimed_at is null or claimed_at < transition_at - interval '15 minutes');

  select * into reversal
  from public.payment_transfer_reversals
  where transaction_id = transaction.id
    and status = 'processing';
  if reversal.id is not null then
    return jsonb_build_object(
      'should_process', false,
      'busy', true,
      'status', reversal.status,
      'recovery_id', reversal.id,
      'target_amount_cents', reversal.target_amount_cents
    );
  end if;

  select * into reversal
  from public.payment_transfer_reversals
  where transaction_id = transaction.id
    and status in ('pending', 'failed')
    and next_attempt_at <= transition_at
  order by target_amount_cents desc
  limit 1
  for update;

  if reversal.id is null then
    select * into reversal
    from public.payment_transfer_reversals
    where transaction_id = transaction.id
    order by target_amount_cents desc
    limit 1;
    return jsonb_build_object(
      'should_process', false,
      'busy', false,
      'status', reversal.status,
      'recovery_id', reversal.id,
      'target_amount_cents', reversal.target_amount_cents,
      'next_attempt_at', reversal.next_attempt_at
    );
  end if;

  update public.payment_transfer_reversals
  set status = 'processing', claimed_at = transition_at,
      attempt_count = attempt_count + 1,
      next_attempt_at = transition_at
  where id = reversal.id
  returning * into reversal;

  update public.payment_transactions
  set payout_recovery_status = 'processing'
  where id = transaction.id;

  return jsonb_build_object(
    'should_process', true,
    'busy', false,
    'status', reversal.status,
    'recovery_id', reversal.id,
    'transaction_id', transaction.id,
    'stripe_transfer_id', reversal.stripe_transfer_id,
    'stripe_charge_id', transaction.stripe_charge_id,
    'currency', transaction.currency,
    'stripe_connected_account_id', transaction.stripe_connected_account_id,
    'payout_amount_cents', transaction.payout_amount_cents,
    'target_amount_cents', reversal.target_amount_cents,
    'idempotency_key', reversal.idempotency_key
  );
end;
$$;

create or replace function public.finalize_campaign_transfer_reversal(
  target_reversal_id uuid,
  reversal_id text,
  reversed_amount_cents bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  reversal public.payment_transfer_reversals;
  transaction public.payment_transactions;
  was_succeeded boolean;
begin
  if reversed_amount_cents < 0 then
    raise exception 'The reversed transfer amount cannot be negative.';
  end if;

  select * into reversal
  from public.payment_transfer_reversals
  where id = target_reversal_id;
  if reversal.id is null then
    raise exception 'Transfer reversal record not found.';
  end if;

  select * into transaction
  from public.payment_transactions
  where id = reversal.transaction_id
  for update;
  if transaction.id is null then
    raise exception 'Payment transaction not found.';
  end if;
  select * into reversal
  from public.payment_transfer_reversals
  where id = target_reversal_id
  for update;
  if reversal.id is null then
    raise exception 'Transfer reversal record not found.';
  end if;
  if transaction.stripe_transfer_id is null
     or transaction.stripe_transfer_id <> reversal.stripe_transfer_id then
    raise exception 'The Stripe transfer does not match the payment ledger.';
  end if;
  if reversed_amount_cents > transaction.payout_amount_cents then
    raise exception 'The reversed transfer amount exceeds the released payout.';
  end if;
  if reversed_amount_cents < reversal.target_amount_cents then
    raise exception 'Stripe has not reversed the full requested transfer amount.';
  end if;

  was_succeeded := reversal.status = 'succeeded';
  if was_succeeded and transaction.payout_recovery_reversed_cents >= reversed_amount_cents then
    return jsonb_build_object(
      'already_finalized', true,
      'transaction', to_jsonb(transaction),
      'reversal_id', reversal.stripe_transfer_reversal_id
    );
  end if;

  update public.payment_transfer_reversals
  set status = 'succeeded', claimed_at = null, next_attempt_at = now(),
      last_error = null
  where transaction_id = transaction.id
    and target_amount_cents <= reversed_amount_cents;

  update public.payment_transfer_reversals
  set stripe_transfer_reversal_id = coalesce(reversal_id, stripe_transfer_reversal_id)
  where id = reversal.id;

  update public.payment_transactions
  set payout_recovery_reversed_cents = greatest(
        payout_recovery_reversed_cents, reversed_amount_cents
      ),
      payout_recovery_status = case
        when payout_recovery_target_cents <= greatest(
          payout_recovery_reversed_cents, reversed_amount_cents
        ) then 'recovered'
        else 'pending'
      end,
      payout_recovery_last_error = null,
      stripe_transfer_reversal_id = coalesce(reversal_id, stripe_transfer_reversal_id)
  where id = transaction.id
  returning * into transaction;

  insert into public.payment_fulfillment_events (
    transaction_id, actor_kind, event_type, from_state, to_state, metadata
  ) values (
    transaction.id, 'stripe', 'payout_transfer_reversed',
    transaction.workflow_status, transaction.workflow_status,
    jsonb_build_object(
      'stripe_transfer_id', reversal.stripe_transfer_id,
      'stripe_transfer_reversal_id', reversal_id,
      'reversed_amount_cents', reversed_amount_cents
    )
  );

  return jsonb_build_object(
    'already_finalized', false,
    'transaction', to_jsonb(transaction),
    'reversal_id', reversal_id
  );
end;
$$;

create or replace function public.record_campaign_transfer_reversal_failure(
  target_reversal_id uuid,
  error_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  reversal public.payment_transfer_reversals;
  transaction public.payment_transactions;
begin
  select * into reversal
  from public.payment_transfer_reversals
  where id = target_reversal_id;
  if reversal.id is null then
    return;
  end if;

  select * into transaction
  from public.payment_transactions
  where id = reversal.transaction_id
  for update;
  if transaction.id is null then
    return;
  end if;

  select * into reversal
  from public.payment_transfer_reversals
  where id = target_reversal_id
  for update;
  if reversal.id is null or reversal.status = 'succeeded' then
    return;
  end if;

  update public.payment_transfer_reversals
  set status = 'failed', claimed_at = null,
      next_attempt_at = clock_timestamp() + interval '15 minutes',
      last_error = left(coalesce(error_message, 'Transfer reversal failed.'), 1000)
  where id = reversal.id;

  update public.payment_transactions
  set payout_recovery_status = case
        when payout_recovery_reversed_cents >= payout_recovery_target_cents
          then 'recovered'
        else 'failed'
      end,
      payout_recovery_last_error = left(
        coalesce(error_message, 'Transfer reversal failed.'), 1000
      )
  where id = transaction.id;
end;
$$;

revoke all on function public.queue_campaign_transfer_reversal(uuid, bigint, text)
  from public, anon, authenticated;
revoke all on function public.finalize_campaign_transfer_reversal(uuid, text, bigint)
  from public, anon, authenticated;
revoke all on function public.record_campaign_transfer_reversal_failure(uuid, text)
  from public, anon, authenticated;
grant execute on function public.queue_campaign_transfer_reversal(uuid, bigint, text)
  to service_role;
grant execute on function public.finalize_campaign_transfer_reversal(uuid, text, bigint)
  to service_role;
grant execute on function public.record_campaign_transfer_reversal_failure(uuid, text)
  to service_role;

comment on table public.payment_transfer_reversals is
  'Idempotent, retryable recovery records for Creator transfers after refunds or lost disputes.';
comment on column public.payment_transactions.payout_recovery_status is
  'Recovery state for a released Creator transfer after a refund or lost dispute.';
