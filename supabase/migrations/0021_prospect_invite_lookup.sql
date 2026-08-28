-- Per-prospect onboarding: the one door from the public site into outreach data.
--
-- Every cold email we send names something specific about that business. The
-- link in it dropped them on a blank thirteen-question form that knew none of
-- it, so the first thing SideSpace did after a personal email was ask a salon
-- owner to type her own salon's name.
--
-- `outreach` is not in PostgREST's exposed schemas and anon has no USAGE on it,
-- which is right and stays that way. This function is the only opening, and it
-- is deliberately narrow:
--
--   * It returns SIX columns. Not email, not website, not hook, not the source
--     URLs we used to research them. A link can be forwarded; none of our
--     research notes travel with it.
--   * Every field it does return is already published on that business's own
--     website - the name, the town, what kind of place it is, the owner's first
--     name. That is where we got them.
--   * The key is the row's uuid, so the set is not enumerable. There is no
--     lookup by name, email or anything else guessable.
--
-- SECURITY DEFINER with an empty search_path, so `outreach.prospects` is
-- resolved literally and cannot be shadowed by a caller-controlled schema.
create or replace function public.invite_prospect(token uuid)
returns table (
  business text,
  city text,
  category text,
  owner_first_name text,
  intent text,
  has_physical_space boolean
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    p.business,
    p.city,
    p.category,
    p.owner_first_name,
    p.intent,
    p.has_physical_space
  from outreach.prospects p
  where p.id = token
  limit 1;
$$;

comment on function public.invite_prospect(uuid) is
  'Prefill data for a cold-email recipient opening their invite link. Returns only fields already public on the business''s own website - never email, website, hook or research URLs.';

-- The whole point is that a signed-out visitor can read their own invite.
revoke all on function public.invite_prospect(uuid) from public;
grant execute on function public.invite_prospect(uuid) to anon, authenticated;
