-- A KPI event outlives the thing it counted.
--
-- Every reference founder_kpi_events holds is `on delete set null`, and that
-- was deliberate. The table records a funnel that already happened, and the
-- migration that created it says so plainly: "A missing profile still
-- represents a real signup in the funnel." Deleting a member is not supposed
-- to rewrite last month's numbers.
--
-- The founder_kpi_event_shape check contradicted that. It required
-- actor_profile_id on an onboarding_completed row, listing_id on a
-- listing_published row, campaign_request_id on a request_sent row - the same
-- columns the foreign keys null out on delete. So the SET NULL fired, the
-- check refused the row it had just produced, and the delete aborted:
--
--   new row for relation "founder_kpi_events" violates check constraint
--   "founder_kpi_event_shape"
--
-- That blocked every delete path into this table, not just one. A member
-- could not be deleted once they had signed up, which is every member who
-- ever signed up; a listing could not be deleted once it had been published;
-- a campaign request could not be deleted once it had been sent. The failure
-- surfaced far from here, as a delete that simply would not go through.
--
-- The shape rule is still worth enforcing - it is what stops a caller
-- recording a request_sent that names no request. It just has to sit where a
-- bad row can be refused without taking an unrelated delete down with it.
-- Nothing writes to this table except private.record_founder_kpi_event: the
-- table is revoked from public, anon, authenticated and service_role, and
-- every trigger reaches it through that one definer function. So the rule
-- moves inside the writer and raises there.
--
-- Inserts are validated exactly as before, including an unrecognised
-- event_type, which now fails with a sentence instead of a constraint name. A
-- row whose subject is later deleted keeps its event_type and its event_day,
-- so the daily counts stay true - which is the behaviour the foreign keys
-- were asking for all along.

alter table private.founder_kpi_events
  drop constraint if exists founder_kpi_event_shape;

create or replace function private.record_founder_kpi_event(
  p_event_type text,
  p_auth_user_id uuid default null,
  p_actor_profile_id uuid default null,
  p_listing_id uuid default null,
  p_campaign_request_id uuid default null,
  p_transaction_id uuid default null,
  p_visitor_hash text default null,
  p_occurred_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_time timestamptz := coalesce(p_occurred_at, clock_timestamp());
  inserted_count integer;
begin
  -- The shape founder_kpi_event_shape used to assert, checked against the
  -- arguments rather than against the stored row, so that nulling a reference
  -- later cannot retroactively invalidate an event that did happen.
  if not (
    (p_event_type = 'signup_completed' and p_auth_user_id is not null)
    or (p_event_type = 'onboarding_completed' and p_actor_profile_id is not null)
    or (
      p_event_type = 'listing_published'
      and p_actor_profile_id is not null
      and p_listing_id is not null
    )
    or (
      p_event_type in ('request_sent', 'campaign_accepted')
      and p_actor_profile_id is not null
      and p_campaign_request_id is not null
    )
    or (
      p_event_type = 'campaign_fulfilled'
      and p_actor_profile_id is not null
      and p_transaction_id is not null
    )
    or (
      p_event_type = 'listing_view'
      and p_listing_id is not null
      and p_visitor_hash is not null
    )
  ) then
    raise exception
      'A % KPI event is missing the reference that identifies it.',
      p_event_type;
  end if;

  insert into private.founder_kpi_events (
    event_type,
    auth_user_id,
    actor_profile_id,
    listing_id,
    campaign_request_id,
    transaction_id,
    visitor_hash,
    event_day,
    occurred_at,
    metadata
  ) values (
    p_event_type,
    p_auth_user_id,
    p_actor_profile_id,
    p_listing_id,
    p_campaign_request_id,
    p_transaction_id,
    p_visitor_hash,
    (event_time at time zone 'UTC')::date,
    event_time,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count = 1;
end;
$$;
