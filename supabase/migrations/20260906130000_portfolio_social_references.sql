-- Social accounts attached to one piece of portfolio work.
--
-- A creator's portfolio item already carries a media URL and a project URL:
-- one thing they made, one place it lives. What it could not say is "and here
-- is the account it went out on", which is the question a business actually
-- asks - the work is only evidence if you can see where it reached people.
--
-- Stored as the resolved URLs rather than platform keys, because this is a
-- record of what a piece of work used, not a live view of the profile. A
-- creator who later changes their Instagram handle has not changed which
-- account last year's campaign ran on, and a portfolio that quietly rewrote
-- itself would be worse evidence, not better.
--
-- No new grants: creator_portfolio_items is granted table-wide (see
-- 20260901063503), so this column is readable by exactly whoever could
-- already read the row. Its policies are untouched - a creator writes their
-- own items and nobody else's.

/**
 * Whether every entry in a portfolio item's social_urls is safe to render as
 * a link on a public profile.
 *
 * A check constraint cannot contain a subquery, and validating each element
 * of an array needs one, so the loop lives in here. Immutable because it
 * reads nothing outside its argument, which is what lets a constraint call
 * it. Not a security definer: it touches no table, so there is no privilege
 * to lend.
 *
 * An empty array and a NULL both pass - having no accounts to name is the
 * normal state of a portfolio item.
 */
create or replace function private.portfolio_social_urls_are_safe(urls text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    bool_and(url ~ '^https://' and pg_catalog.char_length(url) <= 2000),
    true
  )
  from unnest(coalesce(urls, '{}'::text[])) as url;
$$;

revoke all on function private.portfolio_social_urls_are_safe(text[])
  from public, anon, authenticated, service_role;
grant execute on function private.portfolio_social_urls_are_safe(text[])
  to authenticated, service_role;

alter table public.creator_portfolio_items
  add column if not exists social_urls text[] not null default '{}';

comment on column public.creator_portfolio_items.social_urls is
  'The creator''s own social accounts this piece of work ran on, as https URLs, snapshotted at the time so a later profile edit cannot rewrite the record. At most 8.';

alter table public.creator_portfolio_items
  drop constraint if exists creator_portfolio_social_urls_bounded;
alter table public.creator_portfolio_items
  add constraint creator_portfolio_social_urls_bounded
  check (
    coalesce(array_length(social_urls, 1), 0) <= 8
    -- An empty string, an http link or a javascript: URL has no business
    -- rendering as an anchor on somebody's public profile.
    and private.portfolio_social_urls_are_safe(social_urls)
  );
