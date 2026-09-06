begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- The column a creator ticks their own accounts onto. Everything it holds is
-- rendered as an anchor on a public profile, so the database is the last line
-- between a bad string and somebody else's browser.
select has_column('public', 'creator_portfolio_items', 'social_urls',
  'a portfolio item can name the accounts it ran on');
select col_not_null('public', 'creator_portfolio_items', 'social_urls',
  'and never holds NULL - no accounts is an empty list');
select ok(
  has_function_privilege('authenticated', 'private.portfolio_social_urls_are_safe(text[])', 'execute'),
  'a member can write a row the constraint has to check'
);
select ok(
  not has_function_privilege('anon', 'private.portfolio_social_urls_are_safe(text[])', 'execute'),
  'a signed-out visitor has no reason to call the checker'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values ('b1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'portfolio-socials@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (id, auth_user_id, role, display_name, onboarding_complete)
values ('b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001', 'creator', 'Portfolio Socials', true);

select lives_ok(
  $$insert into public.creator_portfolio_items (creator_profile_id, title, description)
    values ('b2000000-0000-4000-8000-000000000001', 'No accounts named', 'Still a portfolio item.')$$,
  'a piece of work can name no accounts at all'
);
select lives_ok(
  $$insert into public.creator_portfolio_items (creator_profile_id, title, description, social_urls)
    values ('b2000000-0000-4000-8000-000000000001', 'Eight accounts', 'The most anyone needs.',
      array(select 'https://example.com/' || g from generate_series(1, 8) g))$$,
  'and up to eight'
);
select throws_ok(
  $$insert into public.creator_portfolio_items (creator_profile_id, title, description, social_urls)
    values ('b2000000-0000-4000-8000-000000000001', 'Nine accounts', 'One too many.',
      array(select 'https://example.com/' || g from generate_series(1, 9) g))$$,
  '23514', null, 'but not nine'
);
select throws_ok(
  $$insert into public.creator_portfolio_items (creator_profile_id, title, description, social_urls)
    values ('b2000000-0000-4000-8000-000000000001', 'Insecure', 'http is not good enough.',
      array['http://insecure.example/account'])$$,
  '23514', null, 'an http link is refused'
);
select throws_ok(
  $$insert into public.creator_portfolio_items (creator_profile_id, title, description, social_urls)
    values ('b2000000-0000-4000-8000-000000000001', 'Script', 'This is the one that matters.',
      array['javascript:alert(1)'])$$,
  '23514', null, 'and a javascript: URL never reaches a public profile'
);
select throws_ok(
  $$insert into public.creator_portfolio_items (creator_profile_id, title, description, social_urls)
    values ('b2000000-0000-4000-8000-000000000001', 'Blank', 'One good, one empty.',
      array['https://instagram.com/someone', ''])$$,
  '23514', null, 'one bad entry refuses the whole row, not just itself'
);

select * from finish();
rollback;
