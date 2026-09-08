begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- The shape rule used to sit on the table, where every `on delete set null`
-- reference could trip it and abort an unrelated delete.
select ok(
  not exists (
    select 1
    from pg_constraint
    where conname = 'founder_kpi_event_shape'
      and conrelid = 'private.founder_kpi_events'::regclass
  ),
  'the shape rule no longer sits on the table where a nulled reference trips it'
);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('9a000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'kpi-delete@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, onboarding_complete, is_internal
)
values
  ('9b000000-0000-4000-8000-000000000001',
   '9a000000-0000-4000-8000-000000000001',
   'creator', 'KPI Delete Fixture', true, false);

insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description,
  status, provenance_status, availability_confirmed_at
)
values
  ('9c000000-0000-4000-8000-000000000001',
   '9b000000-0000-4000-8000-000000000001',
   'KPI delete fixture listing', 'Instagram', 'One post', 10000,
   'A listing used to verify a member can still be deleted.', 'active',
   'owner_attested', now());

select isnt_empty(
  $$select 1 from private.founder_kpi_events
     where actor_profile_id = '9b000000-0000-4000-8000-000000000001'
        or auth_user_id = '9a000000-0000-4000-8000-000000000001'$$,
  'signing up, onboarding and publishing recorded KPI events for the fixture'
);

-- The writer still refuses a malformed event, which is what the constraint
-- was really for.
select throws_ok(
  $$select private.record_founder_kpi_event(
      'request_sent', null, '9b000000-0000-4000-8000-000000000001')$$,
  'A request_sent KPI event is missing the reference that identifies it.',
  'a request_sent that names no request is still refused'
);
select throws_ok(
  $$select private.record_founder_kpi_event('listing_published')$$,
  'A listing_published KPI event is missing the reference that identifies it.',
  'a listing_published that names no listing is still refused'
);
select throws_ok(
  $$select private.record_founder_kpi_event('not_a_real_event')$$,
  'A not_a_real_event KPI event is missing the reference that identifies it.',
  'an unrecognised event type is still refused'
);

select ok(
  private.record_founder_kpi_event(
    'listing_view', null, null, '9c000000-0000-4000-8000-000000000001',
    null, null, repeat('a', 64)),
  'a well-formed event is still recorded'
);

create temporary table kpi_events_before_delete on commit drop as
select id, event_type, event_day
from private.founder_kpi_events
where actor_profile_id = '9b000000-0000-4000-8000-000000000001'
   or auth_user_id = '9a000000-0000-4000-8000-000000000001'
   or listing_id = '9c000000-0000-4000-8000-000000000001';

-- The regression. Each of these aborted while the check sat on the table.
select lives_ok(
  $$delete from public.listings
     where id = '9c000000-0000-4000-8000-000000000001'$$,
  'a published listing can be deleted'
);
select lives_ok(
  $$delete from public.profiles
     where id = '9b000000-0000-4000-8000-000000000001'$$,
  'a member who signed up, onboarded and published can be deleted'
);
select lives_ok(
  $$delete from auth.users
     where id = '9a000000-0000-4000-8000-000000000001'$$,
  'the auth user behind that member can be deleted'
);

-- And the funnel still remembers what happened.
select is(
  (select count(*)::int
     from private.founder_kpi_events event
     join kpi_events_before_delete before on before.id = event.id),
  (select count(*)::int from kpi_events_before_delete),
  'every KPI event survives the deletion of what it counted'
);
select is_empty(
  $$select 1
      from private.founder_kpi_events event
      join kpi_events_before_delete before on before.id = event.id
     where event.event_type is distinct from before.event_type
        or event.event_day is distinct from before.event_day$$,
  'the surviving events kept their type and the day they happened'
);

select * from finish();
rollback;
