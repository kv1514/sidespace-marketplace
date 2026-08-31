-- notify_email_for was addressing notifications to the wrong member.
--
-- The previous migration moved its contact lookup onto a join to
-- public.profile_contacts, which has a COLUMN named profile_id - the same name
-- as the function's parameter. In a SQL function an unqualified name resolves
-- to a column before a parameter, so
--
--   where p.id = profile_id
--
-- silently stopped meaning "the profile asked for" and started meaning
-- "p.id = c.profile_id" - the join condition, true for every row. The function
-- returned whichever row the planner happened to produce first.
--
-- It was caught by counting the addresses it resolved: 36 of 36 profiles, when
-- only 24 have an auth user to get an address from. Nothing consumed it in the
-- window - public.notifications gained no rows - so no mail was misaddressed.
--
-- The contact lookup becomes a scalar subquery. profile_contacts is then never
-- in scope where the parameter is read, and the only relations there, profiles
-- and auth.users, have no profile_id column - so the name can only be the
-- parameter. The signature is unchanged, so named-argument callers keep working.
--
-- Verified after applying: 24 of 36 profiles resolve an address, matching the
-- pre-move function exactly, and every address returned is that member's own.

create or replace function public.notify_email_for(profile_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    nullif(
      (select c.contact_email
         from public.profile_contacts c
        where c.profile_id = p.id),
      ''),
    u.email)
  from public.profiles p
  left join auth.users u on u.id = p.auth_user_id
  where p.id = profile_id;
$$;
