-- Founder-only Slack operations for account summaries, ad-credit grants, and
-- unique referral creation. Slack authentication stays in the application;
-- these functions are a second, service-role-only boundary and provide atomic
-- idempotency plus a private audit trail for every financial mutation.

alter table public.business_ad_credit_referral_codes
  drop constraint if exists business_ad_credit_referral_codes_amount_cents_check;
alter table public.business_ad_credit_referral_codes
  add constraint business_ad_credit_referral_codes_amount_cents_check
  check (amount_cents between 100 and 500000);

alter table public.business_ad_credit_referral_redemptions
  drop constraint if exists business_ad_credit_referral_redemptions_amount_cents_check;
alter table public.business_ad_credit_referral_redemptions
  add constraint business_ad_credit_referral_redemptions_amount_cents_check
  check (amount_cents between 100 and 500000);

alter table public.business_ad_credit_referral_codes
  add column if not exists created_via text not null default 'migration'
    check (created_via in ('migration', 'slack')),
  add column if not exists created_by_slack_user_id text,
  add column if not exists admin_action_key text unique;

alter table public.business_ad_credit_ledger
  drop constraint if exists business_ad_credit_ledger_entry_type_check,
  drop constraint if exists business_ad_credit_entry_type_valid,
  drop constraint if exists business_ad_credit_entry_sign;
alter table public.business_ad_credit_ledger
  add constraint business_ad_credit_entry_type_valid check (
    entry_type in (
      'signup_grant', 'admin_grant', 'checkout_reserve',
      'checkout_release', 'refund_restore'
    )
  ),
  add constraint business_ad_credit_entry_sign check (
    (entry_type in ('signup_grant', 'admin_grant', 'checkout_release', 'refund_restore')
      and amount_cents > 0)
    or (entry_type = 'checkout_reserve' and amount_cents < 0)
  );

create table if not exists private.slack_admin_actions (
  action_key text primary key check (action_key ~ '^[0-9a-f]{64}$'),
  slack_user_id text not null check (slack_user_id ~ '^[A-Z0-9]{6,32}$'),
  action_type text not null check (action_type in ('credit_grant', 'referral_create')),
  target_email text,
  target_profile_id uuid references public.profiles(id) on delete set null,
  amount_cents bigint not null check (amount_cents between 100 and 500000),
  referral_code text references public.business_ad_credit_referral_codes(code) on delete restrict,
  reason text,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint slack_admin_action_shape check (
    (action_type = 'credit_grant' and target_email is not null
      and target_profile_id is not null and referral_code is null
      and char_length(btrim(reason)) between 3 and 500)
    or (action_type = 'referral_create' and target_email is null
      and target_profile_id is null and referral_code is not null and reason is null)
  )
);

revoke all on table private.slack_admin_actions from public, anon, authenticated;
grant select on table private.slack_admin_actions to service_role;

create or replace function public.lookup_business_referral_offer(referral_code text)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select code.amount_cents
  from public.business_ad_credit_referral_codes code
  where code.code = upper(btrim(referral_code))
    and code.active
  limit 1;
$$;

create or replace function public.grant_business_ad_credit_by_email(
  target_email text,
  grant_cents bigint,
  grant_reason text,
  admin_action_key text,
  slack_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text;
  target_profile public.profiles;
  existing_action private.slack_admin_actions;
  new_balance bigint;
  action_result jsonb;
begin
  normalized_email := lower(btrim(target_email));
  if normalized_email = '' or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or grant_cents not between 100 and 500000
     or char_length(btrim(grant_reason)) not between 3 and 500
     or admin_action_key !~ '^[0-9a-f]{64}$'
     or slack_user_id !~ '^[A-Z0-9]{6,32}$' then
    raise exception 'Invalid founder credit grant.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(admin_action_key, 0)
  );
  select * into existing_action
  from private.slack_admin_actions action
  where action.action_key = admin_action_key;
  if existing_action.action_key is not null then
    if existing_action.action_type <> 'credit_grant'
       or existing_action.target_email <> normalized_email
       or existing_action.amount_cents <> grant_cents
       or existing_action.slack_user_id <> grant_business_ad_credit_by_email.slack_user_id then
      raise exception 'The Slack action key was already used for another operation.';
    end if;
    return existing_action.result;
  end if;

  select profile.* into target_profile
  from auth.users account
  join public.profiles profile on profile.auth_user_id = account.id
  where lower(btrim(account.email)) = normalized_email
  limit 1
  for update of profile;
  if target_profile.id is null then
    raise exception 'No SideSpace profile exists for that authenticated email.';
  end if;
  if target_profile.role <> 'business' then
    raise exception 'Advertising credits can only be granted to a Business profile.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_profile.id::text, 0)
  );
  insert into public.business_ad_credit_ledger (
    business_profile_id, amount_cents, entry_type, reference_key
  ) values (
    target_profile.id, grant_cents, 'admin_grant',
    'slack-grant:' || admin_action_key
  );

  select coalesce(sum(ledger.amount_cents), 0)::bigint
  into new_balance
  from public.business_ad_credit_ledger ledger
  where ledger.business_profile_id = target_profile.id;
  if new_balance < 0 then raise exception 'The Business ad credit balance is inconsistent.'; end if;

  action_result := pg_catalog.jsonb_build_object(
    'email', normalized_email,
    'profile_id', target_profile.id,
    'display_name', target_profile.display_name,
    'awarded_cents', grant_cents,
    'balance_cents', new_balance
  );
  insert into private.slack_admin_actions (
    action_key, slack_user_id, action_type, target_email, target_profile_id,
    amount_cents, reason, result
  ) values (
    admin_action_key, grant_business_ad_credit_by_email.slack_user_id,
    'credit_grant', normalized_email, target_profile.id,
    grant_cents, btrim(grant_reason), action_result
  );
  return action_result;
end;
$$;

create or replace function public.create_business_referral_code(
  referral_code text,
  referral_cents bigint,
  admin_action_key text,
  slack_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_code text;
  existing_action private.slack_admin_actions;
  action_result jsonb;
begin
  normalized_code := upper(btrim(referral_code));
  if normalized_code !~ '^[A-Z0-9][A-Z0-9_-]{5,31}$'
     or referral_cents not between 100 and 500000
     or admin_action_key !~ '^[0-9a-f]{64}$'
     or slack_user_id !~ '^[A-Z0-9]{6,32}$' then
    raise exception 'Invalid founder referral creation.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(admin_action_key, 0)
  );
  select * into existing_action
  from private.slack_admin_actions action
  where action.action_key = admin_action_key;
  if existing_action.action_key is not null then
    if existing_action.action_type <> 'referral_create'
       or existing_action.amount_cents <> referral_cents
       or existing_action.slack_user_id <> create_business_referral_code.slack_user_id then
      raise exception 'The Slack action key was already used for another operation.';
    end if;
    return existing_action.result;
  end if;

  insert into public.business_ad_credit_referral_codes (
    code, amount_cents, active, created_via,
    created_by_slack_user_id, admin_action_key
  ) values (
    normalized_code, referral_cents, true, 'slack',
    create_business_referral_code.slack_user_id, admin_action_key
  );
  action_result := pg_catalog.jsonb_build_object(
    'code', normalized_code,
    'amount_cents', referral_cents,
    'active', true
  );
  insert into private.slack_admin_actions (
    action_key, slack_user_id, action_type, amount_cents,
    referral_code, result
  ) values (
    admin_action_key, create_business_referral_code.slack_user_id,
    'referral_create', referral_cents, normalized_code, action_result
  );
  return action_result;
end;
$$;

create or replace function public.get_sidespace_admin_user_summary(target_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_email text;
  account auth.users;
  target_profile public.profiles;
  credit_balance bigint := 0;
  listing_count bigint := 0;
  listing_rows jsonb := '[]'::jsonb;
  buyer_campaigns jsonb := '{}'::jsonb;
  creator_campaigns jsonb := '{}'::jsonb;
  creator_released bigint := 0;
  creator_pending bigint := 0;
  creator_blocked bigint := 0;
  business_charged bigint := 0;
  business_refunded bigint := 0;
  connect_state jsonb := pg_catalog.jsonb_build_object('configured', false);
begin
  normalized_email := lower(btrim(target_email));
  if normalized_email = '' or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid account email.';
  end if;

  select member.* into account
  from auth.users member
  where lower(btrim(member.email)) = normalized_email
  limit 1;
  if account.id is null then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  select profile.* into target_profile
  from public.profiles profile
  where profile.auth_user_id = account.id
  limit 1;
  if target_profile.id is null then
    return pg_catalog.jsonb_build_object(
      'found', true,
      'account', pg_catalog.jsonb_build_object(
        'email', normalized_email,
        'created_at', account.created_at,
        'last_sign_in_at', account.last_sign_in_at
      ),
      'profile', null
    );
  end if;

  select coalesce(sum(ledger.amount_cents), 0)::bigint
  into credit_balance
  from public.business_ad_credit_ledger ledger
  where ledger.business_profile_id = target_profile.id;

  select count(*)::bigint into listing_count
  from public.listings listing
  where listing.owner_profile_id = target_profile.id;
  select coalesce(pg_catalog.jsonb_agg(row_data.item order by row_data.updated_at desc), '[]'::jsonb)
  into listing_rows
  from (
    select
      listing.updated_at,
      pg_catalog.jsonb_build_object(
        'id', listing.id,
        'title', listing.title,
        'channel', listing.channel,
        'status', listing.status,
        'price_cents', listing.price_cents,
        'price_unit', listing.price_unit
      ) as item
    from public.listings listing
    where listing.owner_profile_id = target_profile.id
    order by listing.updated_at desc
    limit 20
  ) row_data;

  select coalesce(pg_catalog.jsonb_object_agg(status_rows.status, status_rows.total), '{}'::jsonb)
  into buyer_campaigns
  from (
    select request.status, count(*)::bigint as total
    from public.campaign_requests request
    where request.requester_profile_id = target_profile.id
    group by request.status
  ) status_rows;
  select coalesce(pg_catalog.jsonb_object_agg(status_rows.status, status_rows.total), '{}'::jsonb)
  into creator_campaigns
  from (
    select request.status, count(*)::bigint as total
    from public.campaign_requests request
    where request.owner_profile_id = target_profile.id
    group by request.status
  ) status_rows;

  select
    coalesce(sum(transaction.payout_amount_cents)
      filter (where transaction.payout_status = 'released'), 0)::bigint,
    coalesce(sum(transaction.payout_amount_cents)
      filter (where transaction.payout_status in ('pending', 'releasing')), 0)::bigint,
    coalesce(sum(transaction.payout_amount_cents)
      filter (where transaction.payout_status = 'blocked'), 0)::bigint
  into creator_released, creator_pending, creator_blocked
  from public.payment_transactions transaction
  where transaction.creator_profile_id = target_profile.id;

  select
    coalesce(sum(transaction.charged_total_cents + transaction.tax_cents)
      filter (where transaction.status in ('paid', 'partially_refunded', 'refunded', 'disputed')), 0)::bigint,
    coalesce(sum(transaction.refunded_cents), 0)::bigint
  into business_charged, business_refunded
  from public.payment_transactions transaction
  where transaction.business_profile_id = target_profile.id;

  select pg_catalog.jsonb_build_object(
    'configured', true,
    'account_id', stripe.stripe_connected_account_id,
    'charges_enabled', stripe.charges_enabled,
    'payouts_enabled', stripe.payouts_enabled,
    'details_submitted', stripe.details_submitted,
    'requirements_due_count', cardinality(stripe.requirements_due)
  ) into connect_state
  from public.stripe_accounts stripe
  where stripe.profile_id = target_profile.id;
  connect_state := coalesce(connect_state, pg_catalog.jsonb_build_object('configured', false));

  return pg_catalog.jsonb_build_object(
    'found', true,
    'account', pg_catalog.jsonb_build_object(
      'email', normalized_email,
      'created_at', account.created_at,
      'last_sign_in_at', account.last_sign_in_at
    ),
    'profile', pg_catalog.jsonb_build_object(
      'id', target_profile.id,
      'display_name', target_profile.display_name,
      'role', target_profile.role,
      'extra_roles', target_profile.extra_roles,
      'onboarding_complete', target_profile.onboarding_complete,
      'verified', target_profile.verified,
      'created_at', target_profile.created_at
    ),
    'ad_credits', pg_catalog.jsonb_build_object('balance_cents', credit_balance),
    'listing_count', listing_count,
    'listings', listing_rows,
    'campaigns', pg_catalog.jsonb_build_object(
      'as_buyer', buyer_campaigns,
      'as_creator', creator_campaigns
    ),
    'creator_payouts', pg_catalog.jsonb_build_object(
      'released_cents', creator_released,
      'pending_cents', creator_pending,
      'blocked_cents', creator_blocked
    ),
    'business_payments', pg_catalog.jsonb_build_object(
      'charged_cents', business_charged,
      'refunded_cents', business_refunded
    ),
    'stripe_connect', connect_state
  );
end;
$$;

revoke all on function public.lookup_business_referral_offer(text)
  from public, anon, authenticated;
grant execute on function public.lookup_business_referral_offer(text)
  to anon, authenticated, service_role;

revoke all on function public.grant_business_ad_credit_by_email(text, bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.grant_business_ad_credit_by_email(text, bigint, text, text, text)
  to service_role;
revoke all on function public.create_business_referral_code(text, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.create_business_referral_code(text, bigint, text, text)
  to service_role;
revoke all on function public.get_sidespace_admin_user_summary(text)
  from public, anon, authenticated;
grant execute on function public.get_sidespace_admin_user_summary(text)
  to service_role;

comment on table private.slack_admin_actions is
  'Private idempotency and audit log for founder-only Slack financial mutations.';
comment on function public.get_sidespace_admin_user_summary(text) is
  'Service-role-only SideSpace ledger and marketplace summary by authenticated account email.';
