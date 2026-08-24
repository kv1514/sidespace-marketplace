-- Adds the `sponsor_host` role: clubs, teams, events and nonprofits that come
-- to SideSpace looking for sponsors.
--
-- It replaces `consumer` ("Campaign shopper" in the UI), which is the only role
-- in the product that produces nothing. Everything a campaign shopper could do
-- -- browse, message, request a campaign -- any signed-in member can already do.
-- What the role actually did was opt people OUT: it hid onboarding step 3,
-- forced `extra_roles` to '{}', blocked the listings INSERT policy, blocked
-- going active, and paused every live listing the member owned. A role whose
-- entire behaviour is subtraction is not a role, it is a trapdoor.
--
-- A sponsorship host is the opposite: it has something to offer (jersey space,
-- a banner at the field, a booth at the tournament, a named tier) and it lists
-- that like any other supply.
--
-- SAFE TO APPLY AHEAD OF THE CLIENT, deliberately:
--   * both CHECKs are WIDENED, never narrowed, so every existing row still
--     validates and nothing has to be re-checked;
--   * nothing yet WRITES 'sponsor_host' -- only the new onboarding will;
--   * the one consumer row is invisible either way (onboarding_complete is
--     false, so the "Profiles are publicly readable" policy hides it and the
--     homepage filters it out regardless).
--
-- It is still going out in the same pull request as the client that uses it.
-- 0013 and 0014 are on disk because a schema change was applied to production
-- while the code compensating for it sat unmerged, and the live marketplace
-- served twelve invented demo businesses instead of the real listings. Twice.

-- 1. Widen the role CHECK.
--
--    `consumer` stays legal permanently. Three RLS policies (0009:118-124,
--    0009:192, 0011:91-101) still name the literal, and dropping a value from
--    a CHECK forces Postgres to re-validate every row in the table to buy
--    nothing. `sponsor_host <> 'consumer'` is already true, so a sponsorship
--    host satisfies all three of those gates the moment this lands -- which is
--    why this migration touches no RLS policy at all.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('consumer', 'business', 'creator', 'space_owner', 'sponsor_host'));

-- 2. A sponsorship host can also be a creator, a business or a space owner, and
--    any of those can also be a sponsorship host. `consumer` was never a legal
--    extra role precisely because it was subtractive; `sponsor_host` is not.
alter table public.profiles drop constraint if exists profiles_extra_roles_valid;
alter table public.profiles
  add constraint profiles_extra_roles_valid
  check (
    extra_roles <@ array['business', 'creator', 'space_owner', 'sponsor_host']
    and not (role = any (extra_roles))
  );

-- 3. Drop the trigger that pauses a member's live listings when their role
--    becomes 'consumer'.
--
--    Protective, not tidying. Nothing in the UI ever warned that changing your
--    role would pull your listings off the marketplace, and a member who edits
--    their profile and taps the wrong card should not silently lose their
--    storefront window. Since `consumer` stays legal in the CHECK above, the
--    trigger would otherwise remain reachable by any code path that still
--    writes the old value.
drop trigger if exists profiles_pause_listings_on_consumer on public.profiles;
drop function if exists public.pause_listings_when_role_becomes_consumer();

-- 4. Move the remaining consumer rows to `business`.
--
--    A campaign shopper was the buyer, and the buyer role in the new model is
--    Business -- not sponsor_host, which is supply. At time of writing this is
--    exactly one profile: never onboarded, no listings.
--
--    Recorded first so it is reversible with one statement. `private` is not a
--    PostgREST-exposed schema and, unlike `public` and `storage`, carries no
--    default ACL granting new tables to anon or authenticated -- so this table
--    is unreachable through the API.
create table if not exists private.consumer_role_backfill (
  profile_id uuid primary key,
  moved_at   timestamptz not null default now()
);

insert into private.consumer_role_backfill (profile_id)
select id from public.profiles where role = 'consumer' and not is_demo
on conflict (profile_id) do nothing;

update public.profiles
set role = 'business'
where role = 'consumer' and not is_demo;

-- Rollback for step 4:
--   update public.profiles p set role = 'consumer'
--   from private.consumer_role_backfill b
--   where b.profile_id = p.id;
