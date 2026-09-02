-- Business-only onboarding credits.
--
-- A valid outreach link is a bearer invite. When a member completes a Business
-- profile through that link, the authenticated client may redeem it once. The
-- resulting $5 is an internal SideSpace ad credit: its tables are not readable
-- or writable from the browser, and the only server-side mutation paths are
-- checkout reservation, expiry release, and refund restoration. There is no
-- withdrawal or transfer operation for this balance.

-- Keep the original campaign economics as the trusted snapshot. The generated
-- charge amount is the amount Stripe must actually collect after promotion;
-- the Creator payout continues to derive from the original agreed subtotal.
alter table public.payment_transactions
  add column if not exists ad_credit_cents bigint not null default 0;

alter table public.payment_transactions
  add column if not exists charged_total_cents bigint
  generated always as (customer_total_cents - ad_credit_cents) stored;

alter table public.payment_transactions
  drop constraint if exists payment_transactions_ad_credit_valid,
  drop constraint if exists payment_transaction_refund_bound;

alter table public.payment_transactions
  add constraint payment_transactions_ad_credit_valid
    check (
      ad_credit_cents >= 0
      and ad_credit_cents < customer_total_cents
      and charged_total_cents > 0
      and charged_total_cents >= creator_payout_cents
    ),
  add constraint payment_transaction_refund_bound
    check (refunded_cents <= charged_total_cents + tax_cents);

-- The promotion amount is part of the trusted financial snapshot once a
-- payment is verified. It cannot be edited into or out of a paid transaction.
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
    or new.ad_credit_cents is distinct from old.ad_credit_cents
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

-- Keep the invite claim as a tombstone even if the account is later deleted;
-- deleting an account must not make a one-time outreach offer reusable.
create table if not exists public.business_ad_credit_redemptions (
  invite_token uuid primary key,
  business_profile_id uuid unique
    references public.profiles(id) on delete set null,
  amount_cents bigint not null default 500 check (amount_cents = 500),
  created_at timestamptz not null default now()
);

create table if not exists public.business_ad_credit_ledger (
  id bigint generated always as identity primary key,
  business_profile_id uuid not null
    references public.profiles(id) on delete cascade,
  payment_transaction_id uuid
    references public.payment_transactions(id) on delete cascade,
  amount_cents bigint not null check (amount_cents <> 0),
  entry_type text not null
    check (entry_type in (
      'signup_grant',
      'checkout_reserve',
      'checkout_release',
      'refund_restore'
    )),
  reference_key text not null unique,
  created_at timestamptz not null default now(),
  constraint business_ad_credit_entry_sign check (
    (entry_type in ('signup_grant', 'checkout_release', 'refund_restore')
      and amount_cents > 0)
    or (entry_type = 'checkout_reserve' and amount_cents < 0)
  )
);

create index if not exists business_ad_credit_ledger_profile_idx
  on public.business_ad_credit_ledger (business_profile_id, created_at, id);
create index if not exists business_ad_credit_ledger_transaction_idx
  on public.business_ad_credit_ledger (payment_transaction_id, created_at, id)
  where payment_transaction_id is not null;

alter table public.business_ad_credit_redemptions enable row level security;
alter table public.business_ad_credit_ledger enable row level security;

revoke all on public.business_ad_credit_redemptions from public, anon, authenticated;
revoke all on public.business_ad_credit_ledger from public, anon, authenticated;
grant select on public.business_ad_credit_redemptions to service_role;
grant select on public.business_ad_credit_ledger to service_role;

create or replace function public.redeem_business_signup_ad_credit(invite_token uuid)
returns table (awarded_cents bigint, balance_cents bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_profile public.profiles;
  claimed_profile_id uuid;
  grant_exists boolean;
begin
  select profile.* into current_profile
  from public.profiles profile
  where profile.auth_user_id = (select auth.uid())
  limit 1;

  -- A credit is never minted for a Creator, a legacy consumer, an incomplete
  -- profile, or a token that is not a real outreach invite.
  if current_profile.id is null
     or coalesce(current_profile.role, '') <> 'business'
     or not current_profile.onboarding_complete
     or invite_token is null
     or not exists (
       select 1 from outreach.prospects prospect
       where prospect.id = redeem_business_signup_ad_credit.invite_token
         and lower(prospect.intent) = 'demand'
     ) then
    return query select 0::bigint, 0::bigint;
    return;
  end if;

  -- The token is single-use across accounts, and a profile can only have one
  -- redemption. A forwarded link cannot mint multiple grants.
  insert into public.business_ad_credit_redemptions (
    invite_token, business_profile_id
  ) values (
    redeem_business_signup_ad_credit.invite_token, current_profile.id
  ) on conflict on constraint business_ad_credit_redemptions_pkey do nothing;

  select redemption.business_profile_id
  into claimed_profile_id
  from public.business_ad_credit_redemptions redemption
  where redemption.invite_token = redeem_business_signup_ad_credit.invite_token;

  if claimed_profile_id is distinct from current_profile.id then
    return query select 0::bigint, 0::bigint;
    return;
  end if;

  select exists (
    select 1
    from public.business_ad_credit_ledger ledger
    where ledger.reference_key = 'signup:'
      || redeem_business_signup_ad_credit.invite_token::text
  ) into grant_exists;

  insert into public.business_ad_credit_ledger (
    business_profile_id, amount_cents, entry_type, reference_key
  ) values (
    current_profile.id, 500, 'signup_grant',
    'signup:' || redeem_business_signup_ad_credit.invite_token::text
  ) on conflict (reference_key) do nothing;

  select coalesce(sum(ledger.amount_cents), 0)::bigint
  into balance_cents
  from public.business_ad_credit_ledger ledger
  where ledger.business_profile_id = current_profile.id;

  awarded_cents := case when grant_exists then 0 else 500 end;
  return next;
end;
$$;

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
  if maximum_cents > greatest(
    transaction.customer_total_cents
      - greatest(50, transaction.creator_payout_cents),
    0
  ) then
    raise exception 'The requested ad credit exceeds the safe checkout amount.';
  end if;
  reserved_cents := least(available_cents, maximum_cents);

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

create or replace function public.release_business_ad_credit(target_transaction_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction public.payment_transactions;
  reserve_key text;
  release_key text;
  reserved_cents bigint;
  inserted_count integer;
begin
  select * into transaction
  from public.payment_transactions
  where id = target_transaction_id
  for update;
  if transaction.id is null then
    raise exception 'Payment transaction not found.';
  end if;
  if transaction.paid_at is not null
     or transaction.status in ('paid', 'partially_refunded', 'refunded', 'disputed') then
    return 0;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(transaction.business_profile_id::text, 0)
  );
  reserve_key := 'checkout:' || transaction.id::text || ':' || transaction.checkout_attempt::text;
  release_key := 'release:' || transaction.id::text || ':' || transaction.checkout_attempt::text;
  select (-ledger.amount_cents)::bigint into reserved_cents
  from public.business_ad_credit_ledger ledger
  where ledger.reference_key = reserve_key
    and ledger.entry_type = 'checkout_reserve';

  if reserved_cents is null or reserved_cents <= 0 then
    update public.payment_transactions set ad_credit_cents = 0 where id = transaction.id;
    return 0;
  end if;

  insert into public.business_ad_credit_ledger (
    business_profile_id, payment_transaction_id, amount_cents,
    entry_type, reference_key
  ) values (
    transaction.business_profile_id, transaction.id, reserved_cents,
    'checkout_release', release_key
  ) on conflict (reference_key) do nothing;
  get diagnostics inserted_count = row_count;
  update public.payment_transactions set ad_credit_cents = 0 where id = transaction.id;
  return case when inserted_count = 1 then reserved_cents else 0 end;
end;
$$;

create or replace function public.restore_business_ad_credit_for_refund(
  target_transaction_id uuid,
  refund_reference text,
  refunded_cents bigint,
  charge_amount_cents bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction public.payment_transactions;
  target_restore bigint;
  already_restored bigint;
  restore_delta bigint;
  ledger_reference_key text;
begin
  if refund_reference is null or btrim(refund_reference) = ''
     or charge_amount_cents is null or charge_amount_cents <= 0
     or refunded_cents is null or refunded_cents < 0
     or refunded_cents > charge_amount_cents then
    raise exception 'The refund credit restoration amounts are invalid.';
  end if;

  select * into transaction
  from public.payment_transactions
  where id = target_transaction_id
  for update;
  if transaction.id is null then
    raise exception 'Payment transaction not found.';
  end if;
  if transaction.ad_credit_cents <= 0 then
    return 0;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(transaction.business_profile_id::text, 0)
  );
  target_restore := least(
    transaction.ad_credit_cents,
    floor(
      transaction.ad_credit_cents::numeric
      * refunded_cents::numeric
      / charge_amount_cents::numeric
    )::bigint
  );
  select coalesce(sum(ledger.amount_cents), 0)::bigint
  into already_restored
  from public.business_ad_credit_ledger ledger
  where ledger.payment_transaction_id = transaction.id
    and ledger.entry_type = 'refund_restore';
  restore_delta := target_restore - already_restored;
  if restore_delta <= 0 then
    return 0;
  end if;

  ledger_reference_key := 'refund:' || transaction.id::text || ':'
    || btrim(refund_reference) || ':' || refunded_cents::text;
  insert into public.business_ad_credit_ledger (
    business_profile_id, payment_transaction_id, amount_cents,
    entry_type, reference_key
  ) values (
    transaction.business_profile_id, transaction.id, restore_delta,
    'refund_restore', ledger_reference_key
  ) on conflict (reference_key) do nothing;
  return restore_delta;
end;
$$;

-- Refund staff actions must use the actual Stripe charge after credits, not the
-- pre-promotion customer total. Existing transactions have charged_total equal
-- to customer_total, so this is backwards-compatible for every old payment.
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

revoke all on function public.redeem_business_signup_ad_credit(uuid)
  from public, anon;
grant execute on function public.redeem_business_signup_ad_credit(uuid)
  to authenticated, service_role;
revoke all on function public.reserve_business_ad_credit(uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.reserve_business_ad_credit(uuid, uuid, bigint)
  to service_role;
revoke all on function public.release_business_ad_credit(uuid)
  from public, anon, authenticated;
grant execute on function public.release_business_ad_credit(uuid)
  to service_role;
revoke all on function public.restore_business_ad_credit_for_refund(uuid, text, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.restore_business_ad_credit_for_refund(uuid, text, bigint, bigint)
  to service_role;
revoke all on function public.claim_issue_refund_resolution(uuid, uuid, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.claim_issue_refund_resolution(uuid, uuid, text, bigint, text)
  to service_role;

comment on table public.business_ad_credit_ledger is
  'Append-only, non-withdrawable Business advertising credits. Negative checkout reservations remain spent after a verified payment; expiry adds a release entry.';
comment on column public.payment_transactions.ad_credit_cents is
  'Platform-funded Business ad credit applied to this checkout. It never reduces the Creator payout.';
comment on column public.payment_transactions.charged_total_cents is
  'Generated Stripe charge subtotal after ad credit and before automatic tax.';
