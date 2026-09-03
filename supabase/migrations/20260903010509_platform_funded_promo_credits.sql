-- SideSpace funds promotional discounts; creator earnings are unchanged.
-- Apply before deploying the corresponding checkout/webhook/release routes.
begin;
alter table public.payment_transactions
  drop constraint payment_transactions_ad_credit_valid,
  add constraint payment_transactions_ad_credit_valid check (
    ad_credit_cents >= 0 and ad_credit_cents <= customer_total_cents
    and (customer_total_cents - ad_credit_cents = 0 or customer_total_cents - ad_credit_cents >= 50)
  );
-- Generated from immutable checkout economics. Refunds cannot change a
-- transfer's funding source after it has been created or retried.
alter table public.payment_transactions add column payout_funding text
  generated always as (case when customer_total_cents - ad_credit_cents < creator_payout_cents
    then 'platform' else 'charge' end) stored;
comment on column public.payment_transactions.payout_funding is
  'Promo shortfalls use the SideSpace available Stripe balance; charge-backed transfers retain their verified source.';
alter table public.payment_resolution_actions
  add column promo_refund_cents bigint not null default 0 check (promo_refund_cents >= 0),
  drop constraint payment_resolution_actions_refund_amount_cents_check,
  add constraint payment_resolution_actions_refund_amount_cents_check check (
    refund_amount_cents > 0 or (refund_amount_cents = 0 and action = 'full_refund' and promo_refund_cents > 0)
  );

create or replace function public.reserve_business_ad_credit(
  target_business_profile_id uuid,
  target_transaction_id uuid,
  maximum_cents bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction public.payment_transactions;
  profile_role text;
  reserve_key text;
  existing_reserve bigint;
  available_cents bigint;
  reserved_cents bigint;
begin
  if maximum_cents is null or maximum_cents < 0 then
    raise exception 'The maximum ad credit must be non-negative.';
  end if;

  select * into transaction
  from public.payment_transactions
  where id = target_transaction_id
  for update;
  if transaction.id is null then
    raise exception 'Payment transaction not found.';
  end if;
  if transaction.business_profile_id <> target_business_profile_id then
    raise exception 'Ad credit can only be reserved for the paying Business.';
  end if;
  select profile.role into profile_role
  from public.profiles profile
  where profile.id = target_business_profile_id;
  if coalesce(profile_role, '') <> 'business' then
    if transaction.ad_credit_cents <> 0 then
      raise exception 'The payment credit reservation requires a Business payer.';
    end if;
    return jsonb_build_object('reserved_cents', 0, 'charged_total_cents', transaction.customer_total_cents);
  end if;
  if transaction.paid_at is not null
     or transaction.status not in ('requires_checkout', 'checkout_open', 'payment_failed', 'expired') then
    raise exception 'Ad credit cannot be reserved for this payment state.';
  end if;

  -- The route calls this after the transaction exists. A transaction retry must
  -- get the same reservation instead of spending a second grant.
  reserve_key := 'checkout:' || transaction.id::text || ':' || transaction.checkout_attempt::text;
  select (-ledger.amount_cents)::bigint into existing_reserve
  from public.business_ad_credit_ledger ledger
  where ledger.reference_key = reserve_key
    and ledger.entry_type = 'checkout_reserve';
  if existing_reserve is not null and exists (
    select 1 from public.business_ad_credit_ledger
    where reference_key = 'release:' || transaction.id::text || ':' || transaction.checkout_attempt::text
  ) then
    raise exception 'Start a new checkout attempt after releasing promo credit.';
  end if;
  if existing_reserve is not null then
    if existing_reserve > maximum_cents then
      raise exception 'The existing ad credit reservation exceeds the safe checkout amount.';
    end if;
    if transaction.ad_credit_cents <> existing_reserve then
      update public.payment_transactions
      set ad_credit_cents = existing_reserve
      where id = transaction.id;
    end if;
    return jsonb_build_object(
      'reserved_cents', existing_reserve,
      'charged_total_cents', transaction.customer_total_cents - existing_reserve
    );
  end if;
  if transaction.ad_credit_cents <> 0 then
    raise exception 'The payment credit reservation is inconsistent.';
  end if;

  -- Serialize reservations for the same Business while allowing unrelated
  -- checkouts to proceed independently.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_business_profile_id::text, 0)
  );
  select coalesce(sum(ledger.amount_cents), 0)::bigint
  into available_cents
  from public.business_ad_credit_ledger ledger
  where ledger.business_profile_id = target_business_profile_id;
  if available_cents < 0 then
    raise exception 'The Business ad credit balance is inconsistent.';
  end if;
  if maximum_cents > transaction.customer_total_cents then
    raise exception 'The requested ad credit exceeds the checkout amount.';
  end if;
  reserved_cents := least(available_cents, maximum_cents);
  -- Fully credited orders need no charge. Partial credits must leave either
  -- zero or Stripe's minimum USD charge; unspent cents stay in the ledger.
  if reserved_cents < transaction.customer_total_cents then
    reserved_cents := least(reserved_cents, greatest(0, transaction.customer_total_cents - 50));
  end if;

  if reserved_cents > 0 then
    insert into public.business_ad_credit_ledger (
      business_profile_id, payment_transaction_id, amount_cents,
      entry_type, reference_key
    ) values (
      target_business_profile_id, transaction.id, -reserved_cents,
      'checkout_reserve', reserve_key
    );
  end if;
  update public.payment_transactions
  set ad_credit_cents = reserved_cents
  where id = transaction.id;

  return jsonb_build_object(
    'reserved_cents', reserved_cents,
    'charged_total_cents', transaction.customer_total_cents - reserved_cents
  );
end;
$$;

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
     or (transaction.stripe_charge_id is null and transaction.payout_funding <> 'platform') then
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
    'payout_funding', transaction.payout_funding,
    'currency', transaction.currency,
    'stripe_connected_account_id', transaction.stripe_connected_account_id,
    'payout_amount_cents', transaction.payout_amount_cents,
    'target_amount_cents', reversal.target_amount_cents,
    'idempotency_key', reversal.idempotency_key
  );
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
  if transaction.id is null then raise exception 'Payment transaction not found.'; end if;
  select * into resolution from public.payment_resolution_actions
  where issue_id = issue.id;
  if resolution.id is not null then
    return jsonb_build_object('duplicate', true, 'resolution', to_jsonb(resolution), 'transaction', to_jsonb(transaction));
  end if;
  if issue.status <> 'escalated' or transaction.payout_status <> 'blocked' then
    raise exception 'Only an escalated issue with a pending payout can be refunded.';
  end if;
  if transaction.charged_total_cents = 0 and transaction.tax_cents = 0
     and transaction.ad_credit_cents = transaction.customer_total_cents
     and transaction.ad_credit_cents > 0 and transaction.paid_at is not null
     and transaction.stripe_checkout_session_id is not null then
    if requested_action <> 'full_refund' then
      raise exception 'Use a full promo-credit refund for a fully credited order.';
    end if;
    perform public.restore_business_ad_credit_for_refund(
      transaction.id, 'promo-only:' || issue.id::text,
      transaction.ad_credit_cents, transaction.ad_credit_cents
    );
    insert into public.payment_resolution_actions (
      issue_id, transaction_id, staff_auth_user_id, action, refund_amount_cents,
      promo_refund_cents, idempotency_key, status, completed_at
    ) values (
      issue.id, transaction.id, staff_user_id, 'full_refund', 0,
      transaction.ad_credit_cents, 'sidespace-issue-refund-' || issue.id::text,
      'completed', clock_timestamp()
    ) returning * into resolution;
    update public.payment_issues set status = 'resolved', resolution_action = 'full_refund',
      resolution_notes = trim(notes), resolved_at = clock_timestamp() where id = issue.id;
    update public.payment_transactions set status = 'refunded', workflow_status = 'refunded',
      issue_status = 'resolved', payout_status = 'refunded', payout_amount_cents = 0
      where id = transaction.id returning * into transaction;
    insert into public.payment_fulfillment_events (
      transaction_id, actor_kind, event_type, from_state, to_state, metadata
    ) values (transaction.id, 'staff', 'promo_credit_refunded', 'issue_escalated', 'refunded',
      jsonb_build_object('issue_id', issue.id, 'promo_refund_cents', transaction.ad_credit_cents));
    return jsonb_build_object('duplicate', false, 'resolution', to_jsonb(resolution), 'transaction', to_jsonb(transaction));
  end if;
  if transaction.stripe_charge_id is null then raise exception 'The verified Stripe charge is missing.'; end if;
  total_charge := transaction.charged_total_cents + transaction.tax_cents;
  remaining_charge := total_charge - transaction.refunded_cents;
  refund_amount := case when requested_action = 'full_refund'
    then remaining_charge else requested_refund_cents end;
  if refund_amount is null or refund_amount <= 0 or refund_amount > remaining_charge then
    raise exception 'Refund amount is outside the remaining customer charge.';
  end if;
  if requested_action = 'partial_refund' and refund_amount >= remaining_charge then
    raise exception 'Use full refund when returning the entire remaining charge.';
  end if;
  adjusted_payout := floor(
    transaction.creator_payout_cents::numeric
    * (total_charge - transaction.refunded_cents - refund_amount)::numeric
    / nullif(total_charge, 0)::numeric
  )::bigint;
  if requested_action = 'partial_refund' and adjusted_payout <= 0 then
    raise exception 'The remaining Creator payout is below one cent; use a full refund.';
  end if;

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

revoke all on function public.reserve_business_ad_credit(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.reserve_business_ad_credit(uuid, uuid, bigint) to service_role;
revoke all on function public.queue_campaign_transfer_reversal(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.queue_campaign_transfer_reversal(uuid, bigint, text) to service_role;
revoke all on function public.claim_issue_refund_resolution(uuid, uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.claim_issue_refund_resolution(uuid, uuid, text, bigint, text) to service_role;

-- Atomic aggregation avoids API row limits and balances changing between pages.
create or replace function public.get_business_ad_credit_balance(target_profile_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'balance_cents', coalesce(sum(ledger.amount_cents), 0),
    'activity', coalesce((select jsonb_agg(to_jsonb(recent) order by recent.created_at desc, recent.id desc)
      from (select id, amount_cents, entry_type, created_at
        from public.business_ad_credit_ledger where business_profile_id = target_profile_id
        order by created_at desc, id desc limit 8) recent), '[]'::jsonb)
  ) from public.business_ad_credit_ledger ledger where ledger.business_profile_id = target_profile_id;
$$;
revoke all on function public.get_business_ad_credit_balance(uuid) from public, anon, authenticated;
grant execute on function public.get_business_ad_credit_balance(uuid) to service_role;


alter table public.payment_transactions add column payout_funding_attempt bigint not null default 0 check (payout_funding_attempt >= 0);
create or replace function public.record_platform_payout_funding_failure(
  target_transaction_id uuid, expected_attempt bigint, error_message text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare transaction public.payment_transactions;
begin
  select * into transaction from public.payment_transactions where id = target_transaction_id for update;
  if transaction.id is null then raise exception 'Payment transaction not found.'; end if;
  if transaction.payout_funding <> 'platform' or transaction.payout_status <> 'releasing'
     or transaction.stripe_transfer_id is not null
     or expected_attempt is null or transaction.payout_funding_attempt <> expected_attempt then
    return false;
  end if;
  update public.payment_transactions set payout_funding_attempt = payout_funding_attempt + 1
    where id = target_transaction_id;
  perform public.record_campaign_payout_release_failure(target_transaction_id, error_message);
  return true;
end;
$$;
revoke all on function public.record_platform_payout_funding_failure(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.record_platform_payout_funding_failure(uuid, bigint, text) to service_role;

commit;
