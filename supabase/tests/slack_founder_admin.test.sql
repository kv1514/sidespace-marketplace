begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select extensions.plan(23);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('40000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'slack-business@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('40000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'slack-creator@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, onboarding_complete
)
values
  ('40000000-0000-4000-8000-000000000011',
   '40000000-0000-4000-8000-000000000001',
   'business', 'Slack Test Business', true),
  ('40000000-0000-4000-8000-000000000012',
   '40000000-0000-4000-8000-000000000002',
   'creator', 'Slack Test Creator', true);

insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description
)
values (
  '40000000-0000-4000-8000-000000000021',
  '40000000-0000-4000-8000-000000000011',
  'Founder dashboard fixture', 'Physical', 'Placement', 25000,
  'Founder command account-summary fixture'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.grant_business_ad_credit_by_email(text,bigint,text,text,text)',
    'execute'
  ),
  'anonymous clients cannot grant ad credit'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.grant_business_ad_credit_by_email(text,bigint,text,text,text)',
    'execute'
  ),
  'authenticated clients cannot grant ad credit'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.grant_business_ad_credit_by_email(text,bigint,text,text,text)',
    'execute'
  ),
  'the server service role can call the narrow grant RPC'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.get_sidespace_admin_user_summary(text)', 'execute'
  ),
  'members cannot query another account summary'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.create_business_referral_code(text,bigint,text,text)',
    'execute'
  ),
  'members cannot create referral codes'
);
select ok(
  has_function_privilege(
    'anon', 'public.lookup_business_referral_offer(text)', 'execute'
  ),
  'a recipient can resolve the value of a known referral code'
);
select ok(
  not has_table_privilege(
    'authenticated', 'private.slack_admin_actions', 'select'
  ),
  'members cannot read the founder audit log'
);
select ok(
  (select relrowsecurity from pg_class
    where oid = 'private.slack_admin_actions'::regclass),
  'the founder audit log has row-level security enabled'
);

select is(
  (public.get_sidespace_admin_user_summary(' SLACK-BUSINESS@example.invalid ')
    ->>'found')::boolean,
  true,
  'account lookup normalizes authenticated email'
);
select is(
  (public.get_sidespace_admin_user_summary('slack-business@example.invalid')
    ->>'listing_count')::bigint,
  1::bigint,
  'account summary counts owned listings'
);
select is(
  public.get_sidespace_admin_user_summary('missing@example.invalid')->>'found',
  'false',
  'account lookup reports an unknown email without leaking another account'
);

select is(
  public.grant_business_ad_credit_by_email(
    'slack-business@example.invalid', 2500, 'Controlled launch grant',
    repeat('a', 64), 'U123456'
  )->>'balance_cents',
  '2500',
  'founder grant credits the Business ledger atomically'
);
select is(
  public.grant_business_ad_credit_by_email(
    'slack-business@example.invalid', 2500, 'Controlled launch grant',
    repeat('a', 64), 'U123456'
  )->>'balance_cents',
  '2500',
  'replaying the same signed Slack action returns the stored result'
);
select is(
  (select count(*)::integer
   from public.business_ad_credit_ledger ledger
   where ledger.reference_key = 'slack-grant:' || repeat('a', 64)),
  1,
  'a retried Slack request cannot mint a second ledger entry'
);
select throws_ok(
  $$select public.grant_business_ad_credit_by_email(
    'slack-business@example.invalid', 2600, 'Changed replay',
    repeat('a', 64), 'U123456'
  )$$,
  'P0001',
  'The Slack action key was already used for another operation.',
  'an action key cannot be reused with changed financial terms'
);
select throws_ok(
  $$select public.grant_business_ad_credit_by_email(
    'slack-creator@example.invalid', 2500, 'Wrong account type',
    repeat('b', 64), 'U123456'
  )$$,
  'P0001',
  'Advertising credits can only be granted to a Business profile.',
  'ad credit cannot be granted to a Creator profile'
);

select is(
  public.create_business_referral_code(
    'ss-pgtap123', 1000, repeat('c', 64), 'U123456'
  )->>'code',
  'SS-PGTAP123',
  'founder referral creation normalizes and stores a unique code'
);
select is(
  public.lookup_business_referral_offer(' ss-pgtap123 '),
  1000::bigint,
  'a known active referral exposes only its promotion value'
);
select is(
  public.create_business_referral_code(
    'SS-DIFFERENT', 1000, repeat('c', 64), 'U123456'
  )->>'code',
  'SS-PGTAP123',
  'a Slack retry returns its original referral instead of creating another'
);
select throws_ok(
  $$select public.create_business_referral_code(
    'SS-PGTAP123', 1000, repeat('d', 64), 'U123456'
  )$$,
  '23505',
  null,
  'a referral code can never be created twice'
);
select throws_ok(
  $$select public.create_business_referral_code(
    'SS-TOO-MUCH', 500001, repeat('e', 64), 'U123456'
  )$$,
  'P0001',
  'Invalid founder referral creation.',
  'founder referral liability is capped at $5,000'
);

select set_config(
  'request.jwt.claim.sub',
  '40000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
select is(
  (select awarded_cents
   from public.redeem_business_referral_credit('SS-PGTAP123')),
  1000::bigint,
  'a Business can redeem the founder-configured referral amount'
);
reset role;
select is(
  (select redemption.amount_cents
   from public.business_ad_credit_referral_redemptions redemption
   where redemption.redeemed_email = 'slack-business@example.invalid'),
  1000::bigint,
  'the email tombstone records the dynamic referral amount'
);

select * from extensions.finish();
rollback;
