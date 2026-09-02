-- Shared Business referral code.
--
-- The original outreach credit migration used one prospect UUID per email.
-- Keep that legacy path working for already-sent links, but make the actual
-- promotion claim unique by the authenticated email so one shared referral
-- URL can be used across the entire Business outreach batch.

create table if not exists public.business_ad_credit_referral_codes (
  code text primary key check (code = upper(btrim(code))),
  amount_cents bigint not null default 500 check (amount_cents = 500),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.business_ad_credit_referral_codes (code, amount_cents)
values ('SIDESPACE5', 500)
on conflict (code) do nothing;

create table if not exists public.business_ad_credit_referral_redemptions (
  redeemed_email text primary key
    check (redeemed_email = lower(btrim(redeemed_email))),
  referral_code text not null
    references public.business_ad_credit_referral_codes(code) on delete restrict,
  business_profile_id uuid unique
    references public.profiles(id) on delete set null,
  amount_cents bigint not null default 500 check (amount_cents = 500),
  created_at timestamptz not null default now()
);

-- Preserve one-time claims made through the old per-prospect flow. The email
-- comes from auth.users, never from an untrusted browser payload.
insert into public.business_ad_credit_referral_redemptions (
  redeemed_email, referral_code, business_profile_id, amount_cents, created_at
)
select
  lower(btrim(account.email)),
  'SIDESPACE5',
  legacy.business_profile_id,
  legacy.amount_cents,
  legacy.created_at
from public.business_ad_credit_redemptions legacy
join public.profiles profile on profile.id = legacy.business_profile_id
join auth.users account on account.id = profile.auth_user_id
where account.email is not null
on conflict (redeemed_email) do nothing;

alter table public.business_ad_credit_referral_codes enable row level security;
alter table public.business_ad_credit_referral_redemptions enable row level security;

revoke all on public.business_ad_credit_referral_codes
  from public, anon, authenticated;
revoke all on public.business_ad_credit_referral_redemptions
  from public, anon, authenticated;
grant select on public.business_ad_credit_referral_codes to service_role;
grant select on public.business_ad_credit_referral_redemptions to service_role;

create or replace function public.redeem_business_referral_credit(referral_code text)
returns table (awarded_cents bigint, balance_cents bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_profile public.profiles;
  normalized_email text;
  normalized_code text;
  credit_amount bigint;
  redemption_inserted integer;
  ledger_inserted integer;
begin
  select profile.* into current_profile
  from public.profiles profile
  where profile.auth_user_id = (select auth.uid())
  limit 1;

  if current_profile.id is null
     or coalesce(current_profile.role, '') <> 'business'
     or not current_profile.onboarding_complete then
    return query select 0::bigint, 0::bigint;
    return;
  end if;

  select lower(btrim(account.email))
  into normalized_email
  from auth.users account
  where account.id = current_profile.auth_user_id;
  if normalized_email is null or normalized_email = '' then
    return query select 0::bigint, 0::bigint;
    return;
  end if;

  normalized_code := upper(btrim(referral_code));
  select code.amount_cents
  into credit_amount
  from public.business_ad_credit_referral_codes code
  where code.code = normalized_code
    and code.active;
  if credit_amount is null then
    return query select 0::bigint, 0::bigint;
    return;
  end if;

  -- The email primary key is the once-per-email guard. Keeping a tombstone
  -- when a profile is deleted prevents account deletion from reopening the
  -- promotion for that address.
  insert into public.business_ad_credit_referral_redemptions (
    redeemed_email, referral_code, business_profile_id, amount_cents
  ) values (
    normalized_email, normalized_code, current_profile.id, credit_amount
  ) on conflict on constraint business_ad_credit_referral_redemptions_pkey do nothing;
  get diagnostics redemption_inserted = row_count;

  if redemption_inserted = 0 then
    select coalesce(sum(ledger.amount_cents), 0)::bigint
    into balance_cents
    from public.business_ad_credit_ledger ledger
    where ledger.business_profile_id = current_profile.id;
    awarded_cents := 0;
    return next;
    return;
  end if;

  -- Keep the email out of the ledger reference key while retaining a stable,
  -- idempotent identifier for the grant.
  insert into public.business_ad_credit_ledger (
    business_profile_id, amount_cents, entry_type, reference_key
  ) values (
    current_profile.id,
    credit_amount,
    'signup_grant',
    'signup-referral:' || md5(normalized_email)
  ) on conflict (reference_key) do nothing;
  get diagnostics ledger_inserted = row_count;

  select coalesce(sum(ledger.amount_cents), 0)::bigint
  into balance_cents
  from public.business_ad_credit_ledger ledger
  where ledger.business_profile_id = current_profile.id;

  awarded_cents := case when ledger_inserted = 1 then credit_amount else 0 end;
  return next;
end;
$$;

-- Already-sent personalized DEMAND links remain redeemable, but now delegate
-- to the shared email-keyed claim so they cannot create a second grant.
create or replace function public.redeem_business_signup_ad_credit(invite_token uuid)
returns table (awarded_cents bigint, balance_cents bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if invite_token is null
     or not exists (
       select 1
       from outreach.prospects prospect
       where prospect.id = redeem_business_signup_ad_credit.invite_token
         and lower(prospect.intent) = 'demand'
     ) then
    return query select 0::bigint, 0::bigint;
    return;
  end if;

  return query
  select *
  from public.redeem_business_referral_credit('SIDESPACE5');
end;
$$;

revoke all on function public.redeem_business_referral_credit(text)
  from public, anon, authenticated;
grant execute on function public.redeem_business_referral_credit(text)
  to authenticated, service_role;
revoke all on function public.redeem_business_signup_ad_credit(uuid)
  from public, anon, authenticated;
grant execute on function public.redeem_business_signup_ad_credit(uuid)
  to authenticated, service_role;

comment on table public.business_ad_credit_referral_codes is
  'Active shared Business referral codes for spend-only advertising credits.';
comment on table public.business_ad_credit_referral_redemptions is
  'One-time Business referral claims keyed by normalized authenticated email; no browser access.';
comment on column public.business_ad_credit_referral_redemptions.redeemed_email is
  'Lowercase, trimmed auth email. The primary key enforces one promotion claim per email.';
comment on function public.redeem_business_referral_credit(text) is
  'Redeems one active shared Business referral code for the authenticated email and completed Business profile.';
