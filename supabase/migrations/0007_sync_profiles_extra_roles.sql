-- profiles.extra_roles was applied directly to the live database and never
-- written back into a migration. Without this file a rebuild from
-- supabase/migrations produces a profiles table with no extra_roles column,
-- and because saveOnboarding writes that column on every profile save - both
-- the insert and the update branch - every save would fail with PGRST204.
-- Onboarding would be impossible on a fresh environment.
--
-- Idempotent, and byte-identical to what production already runs, so applying
-- this against the live database is a no-op.

alter table public.profiles
  add column if not exists extra_roles text[] not null default '{}'::text[];

-- Secondary roles must be real roles, and must not repeat the primary one -
-- otherwise a member shows up as "Creator - Creator" in the role label.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_extra_roles_valid'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_extra_roles_valid
      check (
        extra_roles <@ array['business', 'creator', 'space_owner']
        and not (role = any (extra_roles))
      );
  end if;
end $$;
