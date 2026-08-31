-- Drop the three dead columns left behind by the profile_contacts move.
--
-- The previous migration emptied them rather than dropping them, because
-- production was still running code that wrote them. That deploy has landed
-- (138e758), the app now splits private fields out before every profiles
-- write, and all three columns read empty across every row.
--
-- NOT A PURE DROP: notify_email_for() still reads contact_email.
--
-- Function bodies are not tracked dependencies, so Postgres would have allowed
-- the drop and left the function to fail at runtime instead - on the notify
-- path, where nobody is watching. It is redirected at profile_contacts first,
-- in this same transaction, so there is no window where it references a column
-- that is gone.
--
-- CORRECTED IMMEDIATELY AFTER THIS ONE. The rewrite below names the function
-- parameter `profile_id`, and public.profile_contacts has a COLUMN of that
-- name - so `where p.id = profile_id` bound to the column, not the parameter,
-- and the function returned an arbitrary member's address. Kept here as
-- applied, because production recorded it; the fix is the migration that
-- follows, which replaces the join with a scalar subquery. Read them together.
--
-- It stays SECURITY DEFINER: profile_contacts is readable only by the owning
-- member and the service role, and this function has to resolve an address for
-- anyone. Its search_path stays pinned to '' with every name fully qualified.
--
-- The two CHECK constraints on these columns (profiles_contact_email_shape and
-- profiles_business_preferences_object) are dropped by Postgres along with the
-- columns they constrain. profile_contacts carries no shape check: the address
-- reaching it now comes from the same validated form field, and a constraint
-- that rejects a row at save time is worse than a soft one here.

create or replace function public.notify_email_for(profile_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(c.contact_email, ''), u.email)
  from public.profiles p
  left join public.profile_contacts c on c.profile_id = p.id
  left join auth.users u on u.id = p.auth_user_id
  where p.id = profile_id;
$$;

alter table public.profiles drop column if exists contact_email;
alter table public.profiles drop column if exists contact_name;
alter table public.profiles drop column if exists business_preferences;
