alter table public.stripe_accounts
add column if not exists livemode boolean not null default false;

alter table public.stripe_accounts
drop constraint if exists stripe_accounts_pkey;

alter table public.stripe_accounts
add constraint stripe_accounts_pkey primary key (profile_id, livemode);

comment on column public.stripe_accounts.livemode is
  'Separates sandbox/test Stripe customers and connected accounts from live Stripe objects.';
