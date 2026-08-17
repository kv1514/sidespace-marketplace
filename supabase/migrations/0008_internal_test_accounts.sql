-- Marks accounts that exist only to exercise the product: the QA logins and the
-- support login. They are real rows with real auth users, so every flow can be
-- tested end to end, but they must never be presented to a visitor as members.
--
-- Hiding them previously relied on matching display names in the client, which
-- broke the moment a test account was renamed, and which only ever hid the
-- profile card - a test account's LISTINGS still appeared in the marketplace
-- grid, in the channel filter chips, in the "N open listings" count and in the
-- hero. The client now filters on this column in all of those places.
--
-- Idempotent and matches production, so applying it live is a no-op.

alter table public.profiles
  add column if not exists is_internal boolean not null default false;

-- Backfill the accounts that were being hidden by name matching.
update public.profiles
set is_internal = true
where is_internal = false
  and (display_name ilike 'SideSpace QA%' or display_name = 'support');

create index if not exists profiles_is_internal_idx
  on public.profiles (is_internal)
  where is_internal;
