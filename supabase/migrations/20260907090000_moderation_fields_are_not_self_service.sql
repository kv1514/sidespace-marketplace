-- Two administrative decisions a member could make about themselves.
--
-- Both come from the same shape. public.profiles and public.listings each
-- carry a TABLE-level insert/update grant to `authenticated`
-- (20260901151530:111-116), and a table-level grant covers every column,
-- including every column added by a later migration. The row policies gate
-- which ROW a member may write, never which COLUMN, so the only thing standing
-- between a member and an administrative field is a BEFORE trigger that names
-- it. Two fields were added after their guard was written and never got named:
--
--   profiles.suspended_at / suspended_reason (20260904055617). Suspension is
--   enforced entirely by RLS reading suspended_at, and a suspended member
--   keeps a valid session, so `update profiles set suspended_at = null` on
--   their own row lifted the suspension a founder had just applied - silently,
--   with nothing written to the Slack admin log.
--
--   listings.featured_rank (20260906140000). That migration's own comment says
--   an owner "cannot pin their own listing to the top of the marketplace"
--   because the grants are per column. They are per column for SELECT only;
--   UPDATE is table-wide. Setting featured_rank = 1 on their own listing put
--   it first in the default marketplace grid for every visitor, ahead of the
--   founders' picks and the ranking model.
--
-- The fix is a trigger rather than a column-level re-grant. Postgres cannot
-- revoke one column out of a table-level grant, so closing it that way means
-- replacing the table grant with an explicit column list - which then has to
-- be revisited, correctly, on every future column, and gets silently wrong the
-- first time somebody forgets. A trigger that pins the field to its old value
-- is the pattern this schema already uses (protect_profile_trust_fields), and
-- it fails safe: an unnamed new column is writable, but a named one cannot be
-- written by anybody who is not the service role.

-- ---------------------------------------------------------------------------
-- Suspension is a moderation decision, not a profile field.
-- ---------------------------------------------------------------------------

create or replace function public.protect_profile_trust_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.verified = false;
      new.verification_status = 'unverified';
      new.social_verification = '{}'::jsonb;
      new.is_demo = false;
      new.is_internal = false;
      -- Nobody signs up pre-suspended, and nobody signs up un-suspendable.
      new.suspended_at = null;
      new.suspended_reason = null;
    else
      new.auth_user_id = old.auth_user_id;
      new.verified = old.verified;
      new.verification_status = old.verification_status;
      new.social_verification = old.social_verification;
      new.is_demo = old.is_demo;
      new.is_internal = old.is_internal;
      -- Set by the founders through /sidespace suspend, which runs as the
      -- service role and is not affected by this branch.
      new.suspended_at = old.suspended_at;
      new.suspended_reason = old.suspended_reason;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.protect_profile_trust_fields()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Curation is the founders' decision about the marketplace, not an owner's
-- decision about their own listing.
-- ---------------------------------------------------------------------------

/**
 * Hold featured_rank at whatever the service role last set it to.
 *
 * SECURITY INVOKER, and deliberately: the test is on `current_user`, which is
 * the role PostgREST switched to for this request. A definer function would
 * report its owner instead and the guard would never fire. The service role
 * is not `authenticated`, so the Slack commands and any founder tooling write
 * the column normally.
 */
create or replace function private.protect_listing_curation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.featured_rank = null;
    else
      new.featured_rank = old.featured_rank;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.protect_listing_curation()
  from public, anon, authenticated, service_role;

drop trigger if exists listings_protect_curation on public.listings;
create trigger listings_protect_curation
before insert or update on public.listings
for each row execute function private.protect_listing_curation();

comment on function private.protect_listing_curation() is
  'Keeps listings.featured_rank service-role-only. The table-level UPDATE grant to authenticated covers every column, so the row policy alone would let an owner feature themselves.';
