begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- What a block looks like on the board, and the one statement that rearranges
-- it. The interesting property is not that a creator can reorder their own
-- blocks - that was already true - but that a reorder is atomic and that a
-- reorder somebody else asked for writes nothing at all while still telling
-- the caller so.

select has_column('public', 'creator_portfolio_items', 'block_size',
  'a block has a shape');
select col_not_null('public', 'creator_portfolio_items', 'block_size',
  'and always has one - every existing row defaults to medium');
select has_column('public', 'creator_portfolio_items', 'accent',
  'a block can be given emphasis');
select col_not_null('public', 'creator_portfolio_items', 'accent',
  'and empty means paper rather than NULL');
select has_column('public', 'creator_portfolio_items', 'media_focus',
  'a block says which edge of its picture to keep');
select col_not_null('public', 'creator_portfolio_items', 'media_focus',
  'and always says something');

select ok(
  has_function_privilege(
    'authenticated', 'public.set_creator_portfolio_layout(uuid, uuid[], integer[])', 'execute'
  ),
  'a signed-in creator can rearrange a board'
);
select ok(
  not has_function_privilege(
    'anon', 'public.set_creator_portfolio_layout(uuid, uuid[], integer[])', 'execute'
  ),
  'a signed-out visitor cannot'
);
-- SECURITY INVOKER is the whole safety argument: row-level security is still
-- the only thing deciding which rows this touches. A definer function here
-- would let any signed-in member renumber anybody's portfolio.
select is(
  (select prosecdef from pg_proc
   where oid = 'public.set_creator_portfolio_layout(uuid, uuid[], integer[])'::regprocedure),
  false,
  'and it runs as the caller, so the existing update policy is still the gate'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  ('c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'board-owner@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('c1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'board-stranger@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.profiles (id, auth_user_id, role, display_name, onboarding_complete)
values
  ('c2000000-0000-4000-8000-000000000001',
   'c1000000-0000-4000-8000-000000000001', 'creator', 'Board Owner', true),
  ('c2000000-0000-4000-8000-000000000002',
   'c1000000-0000-4000-8000-000000000002', 'creator', 'Board Stranger', true);

insert into public.creator_portfolio_items (
  id, creator_profile_id, title, description, sort_order
) values
  ('c3000000-0000-4000-8000-000000000001',
   'c2000000-0000-4000-8000-000000000001', 'First', 'One.', 0),
  ('c3000000-0000-4000-8000-000000000002',
   'c2000000-0000-4000-8000-000000000001', 'Second', 'Two.', 1),
  ('c3000000-0000-4000-8000-000000000003',
   'c2000000-0000-4000-8000-000000000001', 'Third', 'Three.', 2);

insert into public.creator_portfolio_items (
  id, creator_profile_id, title, description, sort_order
) values
  ('c3000000-0000-4000-8000-000000000009',
   'c2000000-0000-4000-8000-000000000002', 'Not yours', 'Somebody else.', 0);

select is(
  (select block_size from public.creator_portfolio_items
   where id = 'c3000000-0000-4000-8000-000000000001'),
  'medium',
  'a block written without a shape is a medium one'
);
select is(
  (select accent from public.creator_portfolio_items
   where id = 'c3000000-0000-4000-8000-000000000001'),
  '',
  'and is painted on paper'
);
select is(
  (select media_focus from public.creator_portfolio_items
   where id = 'c3000000-0000-4000-8000-000000000001'),
  'center',
  'and keeps the middle of its picture'
);

select throws_ok(
  $$update public.creator_portfolio_items set block_size = 'enormous'
    where id = 'c3000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'a shape the stylesheet cannot draw is refused'
);
select throws_ok(
  $$update public.creator_portfolio_items set accent = 'neon'
    where id = 'c3000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'and so is a colour outside the house palette'
);
select throws_ok(
  $$update public.creator_portfolio_items set media_focus = 'left'
    where id = 'c3000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'and a crop nobody implemented'
);

-- The board's owner, rearranging their own blocks.
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
set local role authenticated;

select is(
  public.set_creator_portfolio_layout(
    'c2000000-0000-4000-8000-000000000001',
    array['c3000000-0000-4000-8000-000000000003',
          'c3000000-0000-4000-8000-000000000001',
          'c3000000-0000-4000-8000-000000000002']::uuid[],
    array[0, 1, 2]
  ),
  3,
  'a creator rearranges their whole board in one statement'
);
select results_eq(
  $$select title from public.creator_portfolio_items
    where creator_profile_id = 'c2000000-0000-4000-8000-000000000001'
    order by sort_order$$,
  $$values ('Third'), ('First'), ('Second')$$,
  'and every block lands where they put it'
);
-- The count has to be the number of blocks sent, not the number whose position
-- changed. A caller cannot tell "already in the right place" from "filtered
-- away by row-level security" if those two produce the same number.
select is(
  public.set_creator_portfolio_layout(
    'c2000000-0000-4000-8000-000000000001',
    array['c3000000-0000-4000-8000-000000000003',
          'c3000000-0000-4000-8000-000000000001',
          'c3000000-0000-4000-8000-000000000002']::uuid[],
    array[0, 1, 2]
  ),
  3,
  'writing the arrangement it already has still counts every block'
);

select is(
  public.set_creator_portfolio_layout(
    'c2000000-0000-4000-8000-000000000002',
    array['c3000000-0000-4000-8000-000000000009']::uuid[],
    array[7]
  ),
  0,
  'somebody else''s board is filtered to nothing rather than rearranged'
);
-- 7 rather than the 0 it already holds: a leak has to be able to leave a mark,
-- or the assertion below passes whether or not the policy is doing anything.
select is(
  (select sort_order from public.creator_portfolio_items
   where id = 'c3000000-0000-4000-8000-000000000009'),
  0,
  'and their block did not move'
);

select is(
  public.set_creator_portfolio_layout(
    'c2000000-0000-4000-8000-000000000001',
    array['c3000000-0000-4000-8000-000000000001',
          'c3000000-0000-4000-8000-000000000002']::uuid[],
    array[0]
  ),
  0,
  'a call whose arrays do not line up writes nothing'
);
select is(
  public.set_creator_portfolio_layout(
    'c2000000-0000-4000-8000-000000000001',
    array['c3000000-0000-4000-8000-000000000001']::uuid[],
    array[-1]
  ),
  0,
  'and a position the sort_order check would refuse is turned down whole'
);
select results_eq(
  $$select title from public.creator_portfolio_items
    where creator_profile_id = 'c2000000-0000-4000-8000-000000000001'
    order by sort_order$$,
  $$values ('Third'), ('First'), ('Second')$$,
  'a refused call leaves the arrangement exactly as it was'
);

reset role;
select * from finish();
rollback;
