begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

insert into public.profiles (id, role, display_name, is_demo, onboarding_complete)
values
  ('20000000-0000-4000-8000-000000000001', 'business', 'Safety Buyer', true, true),
  ('20000000-0000-4000-8000-000000000002', 'creator', 'Safety Demo', true, true);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('30000000-0000-4000-8000-000000000011', 'authenticated', 'authenticated', 'rls-buyer@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('30000000-0000-4000-8000-000000000012', 'authenticated', 'authenticated', 'rls-creator@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('30000000-0000-4000-8000-000000000013', 'authenticated', 'authenticated', 'rls-other@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description
) values (
  '20000000-0000-4000-8000-000000000010',
  '20000000-0000-4000-8000-000000000002',
  'View-only fixture', 'Instagram', 'Post', 10000, 'Demo inventory'
);

insert into public.profiles (
  id, auth_user_id, role, display_name, is_demo, onboarding_complete
)
values
  ('20000000-0000-4000-8000-000000000011', '30000000-0000-4000-8000-000000000011', 'business', 'RLS Buyer', false, true),
  ('20000000-0000-4000-8000-000000000012', '30000000-0000-4000-8000-000000000012', 'creator', 'RLS Creator', false, true),
  ('20000000-0000-4000-8000-000000000013', '30000000-0000-4000-8000-000000000013', 'creator', 'RLS Other', false, true);

alter table public.listings disable trigger listings_enforce_provenance;
insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description,
  provenance_status, availability_confirmed_at
) values (
  '20000000-0000-4000-8000-000000000014',
  '20000000-0000-4000-8000-000000000012',
  'RLS payment fixture', 'Instagram', 'Post', 10000, 'Payment authorization fixture',
  'owner_attested', now()
);
alter table public.listings enable trigger listings_enforce_provenance;

insert into public.conversations (id, participant_a, participant_b)
values
  ('20000000-0000-4000-8000-000000000015',
   '20000000-0000-4000-8000-000000000011',
   '20000000-0000-4000-8000-000000000012'),
  ('20000000-0000-4000-8000-000000000016',
   '20000000-0000-4000-8000-000000000011',
   '20000000-0000-4000-8000-000000000013');

insert into public.campaign_requests (
  id, listing_id, requester_profile_id, owner_profile_id, campaign_name,
  goals, requested_deliverables, budget_cents, start_date, end_date, status
)
values
  ('20000000-0000-4000-8000-000000000017',
   '20000000-0000-4000-8000-000000000014',
   '20000000-0000-4000-8000-000000000011',
   '20000000-0000-4000-8000-000000000012',
   'RLS payment request', 'Verify payment terms remain immutable', 'One post',
   10000, current_date, current_date + 7, 'pending'),
  ('20000000-0000-4000-8000-000000000018',
   '20000000-0000-4000-8000-000000000014',
   '20000000-0000-4000-8000-000000000011',
   '20000000-0000-4000-8000-000000000012',
   'RLS wrong conversation', 'Verify conversation ownership is checked', 'One post',
   10000, current_date, current_date + 7, 'pending');

select is(
  (select provenance_status from public.listings
   where id = '20000000-0000-4000-8000-000000000010'),
  'demo',
  'demo owners always produce demo inventory'
);

select throws_ok(
  $$insert into public.campaign_requests (
      listing_id, requester_profile_id, owner_profile_id, campaign_name,
      goals, requested_deliverables, budget_cents, start_date, end_date, status
    ) values (
      '20000000-0000-4000-8000-000000000010',
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      'Safety request', 'Test the provenance boundary', 'One post', 10000,
      current_date, current_date + 7, 'pending'
    )$$,
  'P0001',
  'The listing owner must confirm this inventory before requests can continue.',
  'demo inventory cannot receive campaign requests'
);

select ok(
  public.claim_payment_rate_limit(
    'pgtap_payment', '20000000-0000-4000-8000-000000000001', 2, 60
  ),
  'first payment mutation is allowed'
);
select ok(
  public.claim_payment_rate_limit(
    'pgtap_payment', '20000000-0000-4000-8000-000000000001', 2, 60
  ),
  'second payment mutation is allowed'
);
select is(
  public.claim_payment_rate_limit(
    'pgtap_payment', '20000000-0000-4000-8000-000000000001', 2, 60
  ),
  false,
  'payment mutation is denied after the durable limit'
);

select ok(
  not has_function_privilege(
    'anon', 'public.notify_email_for(uuid)', 'execute'
  ),
  'anonymous clients cannot resolve private notification email addresses'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.notify_email_for(uuid)', 'execute'
  ),
  'authenticated clients cannot resolve private notification email addresses'
);
select ok(
  not has_function_privilege(
    'anon', 'public.queue_notification(uuid,text,uuid,text,text)', 'execute'
  ),
  'anonymous clients cannot write notification outbox rows'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.queue_notification(uuid,text,uuid,text,text)', 'execute'
  ),
  'authenticated clients cannot write notification outbox rows'
);

select ok(
  not has_function_privilege(
    'anon', 'public.queue_campaign_transfer_reversal(uuid,bigint,text)', 'execute'
  ),
  'anonymous clients cannot queue transfer reversals'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.queue_campaign_transfer_reversal(uuid,bigint,text)', 'execute'
  ),
  'authenticated clients cannot queue transfer reversals'
);
select ok(
  not has_function_privilege(
    'anon', 'public.finalize_campaign_transfer_reversal(uuid,text,bigint)', 'execute'
  ),
  'anonymous clients cannot finalize transfer reversals'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.finalize_campaign_transfer_reversal(uuid,text,bigint)', 'execute'
  ),
  'authenticated clients cannot finalize transfer reversals'
);
select ok(
  not has_function_privilege(
    'anon', 'public.record_campaign_transfer_reversal_failure(uuid,text)', 'execute'
  ),
  'anonymous clients cannot mutate transfer-recovery failures'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.record_campaign_transfer_reversal_failure(uuid,text)', 'execute'
  ),
  'authenticated clients cannot mutate transfer-recovery failures'
);

select ok(
  not has_table_privilege(
    'authenticated', 'public.campaign_requests', 'UPDATE'
  ),
  'authenticated clients cannot update campaign request terms directly'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.link_campaign_request_conversation(uuid,uuid)',
    'execute'
  ),
  'authenticated clients can use the narrow conversation-link RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.link_campaign_request_conversation(uuid,uuid)',
    'execute'
  ),
  'anonymous clients cannot link campaign conversations'
);

select set_config(
  'request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000011',
  true
);
set local role authenticated;

select is(
  public.link_campaign_request_conversation(
    '20000000-0000-4000-8000-000000000017',
    '20000000-0000-4000-8000-000000000015'
  ),
  '20000000-0000-4000-8000-000000000017'::uuid,
  'the requester can link the exact owner conversation through the RPC'
);
select is(
  (select conversation_id from public.campaign_requests
   where id = '20000000-0000-4000-8000-000000000017'),
  '20000000-0000-4000-8000-000000000015'::uuid,
  'the narrow RPC links only the conversation field'
);
select is(
  (select budget_cents from public.campaign_requests
   where id = '20000000-0000-4000-8000-000000000017'),
  10000::bigint,
  'the conversation-link RPC cannot change the payment budget'
);
select is(
  (select campaign_name from public.campaign_requests
   where id = '20000000-0000-4000-8000-000000000017'),
  'RLS payment request',
  'the conversation-link RPC cannot change campaign terms'
);
select is(
  public.link_campaign_request_conversation(
    '20000000-0000-4000-8000-000000000017',
    '20000000-0000-4000-8000-000000000015'
  ),
  '20000000-0000-4000-8000-000000000017'::uuid,
  'repeating the same conversation link is idempotent'
);
select throws_ok(
  $$select public.link_campaign_request_conversation(
    '20000000-0000-4000-8000-000000000018',
    '20000000-0000-4000-8000-000000000016'
  )$$,
  'P0001',
  'The conversation must be between the requester and listing owner.',
  'the RPC rejects a conversation with the wrong participant'
);
select set_config(
  'request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000012',
  true
);
select lives_ok(
  $$select public.respond_campaign_request(
    '20000000-0000-4000-8000-000000000018',
    'accepted', null::bigint, ''
  )$$,
  'authenticated campaign responses still work after direct UPDATE is revoked'
);
select is(
  (select accepted_subtotal_cents from public.campaign_requests
   where id = '20000000-0000-4000-8000-000000000018'),
  10000::bigint,
  'the accepted payment snapshot still records the trusted budget'
);
select is(
  (select payer_profile_id from public.campaign_requests
   where id = '20000000-0000-4000-8000-000000000018'),
  '20000000-0000-4000-8000-000000000011'::uuid,
  'the accepted response still assigns the requester as payer'
);
select is(
  (select payee_profile_id from public.campaign_requests
   where id = '20000000-0000-4000-8000-000000000018'),
  '20000000-0000-4000-8000-000000000012'::uuid,
  'the accepted response still assigns the owner as payee'
);
reset role;

select * from finish();
rollback;
