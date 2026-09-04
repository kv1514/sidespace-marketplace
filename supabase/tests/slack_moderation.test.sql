begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select extensions.plan(12);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('50000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'mod-target@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('50000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'mod-staff@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (
  id, auth_user_id, role, display_name, onboarding_complete, is_internal
)
values
  ('50000000-0000-4000-8000-000000000011',
   '50000000-0000-4000-8000-000000000001', 'business', 'Moderation Target', true, false),
  ('50000000-0000-4000-8000-000000000012',
   '50000000-0000-4000-8000-000000000002', 'business', 'Moderation Staff', true, true);

insert into public.listings (
  id, owner_profile_id, title, channel, format, price_cents, description
)
values
  ('50000000-0000-4000-8000-000000000021',
   '50000000-0000-4000-8000-000000000011',
   'Quxzzybrand pop-up counter', 'Shop counter', 'Counter card', 5000,
   'A counter by the register.'),
  -- The listing that must survive every broad pattern. A jerky stand is
  -- exactly the small business this marketplace exists for.
  ('50000000-0000-4000-8000-000000000022',
   '50000000-0000-4000-8000-000000000011',
   'Beef jerky stand at the farmers market', 'Shop counter', 'Counter card', 4000,
   'Jamaican jerk chicken window next door.');

-- ── suspension ─────────────────────────────────────────────────────────────
select extensions.lives_ok(
  $$select public.set_member_suspension_by_email(
      'mod-target@example.invalid', true, 'Obscene listings',
      repeat('1', 64), 'U01TESTAA')$$,
  'a founder can suspend a member');

select extensions.isnt(
  (select suspended_at from public.profiles where id = '50000000-0000-4000-8000-000000000011'),
  null, 'suspension is recorded on the profile');

select extensions.is(
  (select suspended_reason from public.profiles where id = '50000000-0000-4000-8000-000000000011'),
  'Obscene listings', 'the reason is stored for the audit trail');

select extensions.is(
  (select count(*)::int from private.slack_admin_actions where action_type = 'member_suspend'),
  1, 'the suspension is audit logged');

-- Slack retries the same signed request; it must not double-apply.
select extensions.lives_ok(
  $$select public.set_member_suspension_by_email(
      'mod-target@example.invalid', true, 'Obscene listings',
      repeat('1', 64), 'U01TESTAA')$$,
  'a Slack retry replays rather than reapplying');

select extensions.is(
  (select count(*)::int from private.slack_admin_actions where action_type = 'member_suspend'),
  1, 'the retry wrote no second audit row');

select extensions.throws_ok(
  $$select public.set_member_suspension_by_email(
      'mod-staff@example.invalid', true, 'Nope', repeat('2', 64), 'U01TESTAA')$$,
  'Internal SideSpace accounts cannot be suspended.',
  'an internal SideSpace account cannot be suspended');

select extensions.lives_ok(
  $$select public.set_member_suspension_by_email(
      'mod-target@example.invalid', false, null, repeat('3', 64), 'U01TESTAA')$$,
  'a suspension can be lifted');

select extensions.is(
  (select suspended_at from public.profiles where id = '50000000-0000-4000-8000-000000000011'),
  null, 'restoring clears the suspension');

-- ── blocklist ──────────────────────────────────────────────────────────────
-- A pattern that does not compile would make the listings trigger raise on
-- every publish, for every member.
select extensions.throws_ok(
  $$select public.set_listing_blocklist_pattern(
      'bad[unclosed', true, 'test', repeat('4', 64), 'U01TESTAA')$$,
  'That is not a valid search pattern.',
  'an uncompilable pattern is refused before it can be stored');

-- THE ONE THAT MATTERS: a pattern broad enough to hit a listing from a member
-- in good standing is refused, so "jerk" can never quietly take down the jerky
-- stand above.
select extensions.throws_like(
  $$select public.set_listing_blocklist_pattern(
      'jerk', true, 'too broad', repeat('5', 64), 'U01TESTAA')$$,
  'That pattern would block%',
  'a pattern that would hit a good-standing listing is refused, and says which');

select extensions.lives_ok(
  $$select public.set_listing_blocklist_pattern(
      'quxzzybrand', true, 'Banned brand', repeat('6', 64), 'U01TESTAA')$$,
  'a narrow brand pattern is accepted');

select * from extensions.finish();
rollback;
