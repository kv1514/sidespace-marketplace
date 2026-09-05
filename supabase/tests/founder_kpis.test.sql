begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('91000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'kpi-business@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('91000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'kpi-creator@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('91000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
   'kpi-internal@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, onboarding_complete, is_internal
)
values
  ('92000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000001',
   'business', 'KPI Test Business', true, false),
  ('92000000-0000-4000-8000-000000000002',
   '91000000-0000-4000-8000-000000000002',
   'creator', 'KPI Test Creator', true, false),
  ('92000000-0000-4000-8000-000000000003',
   '91000000-0000-4000-8000-000000000003',
   'creator', 'KPI Internal Fixture', true, true);

insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description,
  status, provenance_status, availability_confirmed_at
)
values
  ('93000000-0000-4000-8000-000000000001',
   '92000000-0000-4000-8000-000000000002',
   'KPI test listing', 'Instagram', 'One post', 10000,
   'A listing used to verify founder reporting.', 'active',
   'owner_attested', now()),
  ('93000000-0000-4000-8000-000000000002',
   '92000000-0000-4000-8000-000000000003',
   'Internal KPI fixture', 'Instagram', 'One post', 10000,
   'This listing must never enter founder metrics.', 'active',
   'owner_attested', now());

select ok(
  not has_function_privilege(
    'anon', 'public.record_listing_view(uuid,text)', 'execute'
  ),
  'anonymous clients cannot write listing-view events'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.record_listing_view(uuid,text)', 'execute'
  ),
  'authenticated clients cannot write listing-view events directly'
);
select ok(
  has_function_privilege(
    'service_role', 'public.record_listing_view(uuid,text)', 'execute'
  ),
  'the server service role can record listing views'
);
select ok(
  not has_function_privilege(
    'anon', 'public.get_sidespace_founder_kpis(integer)', 'execute'
  ),
  'anonymous clients cannot query founder KPIs'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.get_sidespace_founder_kpis(integer)', 'execute'
  ),
  'authenticated clients cannot query founder KPIs'
);
select ok(
  has_function_privilege(
    'service_role', 'public.get_sidespace_founder_kpis(integer)', 'execute'
  ),
  'the server service role can query founder KPIs'
);
select ok(
  not has_table_privilege('authenticated', 'private.founder_kpi_events', 'select'),
  'members cannot read raw founder events'
);
select ok(
  (select relrowsecurity
   from pg_class
   where oid = 'private.founder_kpi_events'::regclass),
  'raw founder events have row-level security enabled'
);

select is(
  (select count(*)::integer
   from private.founder_kpi_events
   where event_type = 'signup_completed'
     and auth_user_id = '91000000-0000-4000-8000-000000000001'),
  1,
  'auth signup creates one private signup event'
);
select is(
  (select count(*)::integer
   from private.founder_kpi_events
   where event_type = 'onboarding_completed'
     and actor_profile_id = '92000000-0000-4000-8000-000000000001'),
  1,
  'completed onboarding creates one private milestone'
);
select is(
  (select count(*)::integer
   from private.founder_kpi_events
   where event_type = 'listing_published'
     and listing_id = '93000000-0000-4000-8000-000000000001'),
  1,
  'a real active listing creates one publication event'
);
select is(
  (select count(*)::integer
   from private.founder_kpi_events
   where event_type = 'listing_published'
     and listing_id = '93000000-0000-4000-8000-000000000002'),
  0,
  'an internal listing is excluded at event-recording time'
);

insert into public.campaign_requests (
  id, listing_id, requester_profile_id, owner_profile_id, campaign_name,
  goals, requested_deliverables, budget_cents, start_date, end_date, status
)
values (
  '94000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000002',
  'KPI test campaign', 'Verify the funnel events', 'One post', 10000,
  current_date + 3, current_date + 3, 'pending'
);
update public.campaign_requests
set status = 'accepted',
    accepted_subtotal_cents = 10000,
    payer_profile_id = requester_profile_id,
    payee_profile_id = owner_profile_id
where id = '94000000-0000-4000-8000-000000000001';
update public.campaign_requests
set status = 'accepted'
where id = '94000000-0000-4000-8000-000000000001';

select is(
  (select count(*)::integer
   from private.founder_kpi_events
   where event_type = 'request_sent'
     and campaign_request_id = '94000000-0000-4000-8000-000000000001'),
  1,
  'a request creates one request-sent milestone'
);
select is(
  (select count(*)::integer
   from private.founder_kpi_events
   where event_type = 'campaign_accepted'
     and campaign_request_id = '94000000-0000-4000-8000-000000000001'),
  1,
  'a pending-to-accepted transition creates one acceptance milestone'
);

select is(
  public.record_listing_view(
    '93000000-0000-4000-8000-000000000001', repeat('a', 64)
  ),
  true,
  'the server can record the first listing view'
);
select is(
  public.record_listing_view(
    '93000000-0000-4000-8000-000000000001', repeat('a', 64)
  ),
  false,
  'the same visitor cannot add a second view on the same UTC day'
);
select is(
  (select count(*)::integer
   from private.founder_kpi_events
   where event_type = 'listing_view'
     and listing_id = '93000000-0000-4000-8000-000000000001'),
  1,
  'listing-view deduplication leaves one raw event'
);
update public.profiles
set suspended_at = now()
where id = '92000000-0000-4000-8000-000000000002';
select is(
  public.record_listing_view(
    '93000000-0000-4000-8000-000000000001', repeat('b', 64)
  ),
  false,
  'suspended inventory cannot create public listing views'
);

select is(
  (public.get_sidespace_founder_kpis(30)->'snapshot'->>'members_total')::bigint,
  2::bigint,
  'the snapshot counts real members and excludes the internal fixture'
);
select is(
  (public.get_sidespace_founder_kpis(30)->'snapshot'->>'active_listings')::bigint,
  0::bigint,
  'the snapshot excludes suspended active inventory'
);
select is(
  (public.get_sidespace_founder_kpis(30)->'period_metrics'->>'listing_views')::bigint,
  1::bigint,
  'the period report counts the deduplicated listing view'
);
select is(
  (public.get_sidespace_founder_kpis(30)->'period_metrics'->>'new_members')::bigint,
  2::bigint,
  'the period report counts real signups and excludes the internal signup'
);

select * from finish();
rollback;
