-- Reconcile the hosted database after its migration history diverged from the
-- checkout. The hosted project already had equivalent payment tables, but its
-- alternate lineage left broader browser grants and older payout functions.
-- Keep this migration idempotent: it is safe to apply to the current local
-- schema and to the backed-up hosted schema exactly once.

create or replace function public.claim_campaign_payout_release(
  target_transaction_id uuid,
  release_mode text,
  actor_profile_id uuid default null,
  staff_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction public.payment_transactions;
  transition_at timestamptz := clock_timestamp();
  from_state text;
begin
  select * into transaction from public.payment_transactions
  where id = target_transaction_id for update;
  if transaction.id is null then raise exception 'Payment transaction not found.'; end if;

  -- Authorize before any idempotent early return. Duplicate clicks are safe,
  -- but they must not turn into a way for a non-party to confirm or inspect a
  -- release that another actor already claimed.
  if release_mode = 'payer_confirmation'
     and transaction.business_profile_id <> actor_profile_id then
    raise exception 'Only the payer can confirm completion.';
  elsif release_mode = 'staff' and not exists (
    select 1 from public.staff_members staff
    where staff.auth_user_id = staff_user_id and staff.active
      and staff.role in ('payments_admin', 'admin')
  ) then
    raise exception 'Payments staff authorization is required.';
  elsif release_mode = 'partial_refund_resolution' and not exists (
    select 1 from public.payment_resolution_actions resolution
    where resolution.transaction_id = transaction.id
      and resolution.action = 'partial_refund'
      and resolution.status = 'completed'
  ) then
    raise exception 'The partial refund must complete before payout release.';
  elsif release_mode not in (
    'payer_confirmation', 'automatic', 'staff', 'partial_refund_resolution'
  ) then
    raise exception 'Unknown payout release mode.';
  end if;
  if transaction.payout_status = 'released' then
    return jsonb_build_object('already_released', true, 'transaction', to_jsonb(transaction));
  end if;
  if transaction.payout_status = 'releasing' then
    return jsonb_build_object('already_released', false, 'should_transfer', true, 'transaction', to_jsonb(transaction));
  end if;

  if release_mode = 'payer_confirmation' then
    if transaction.workflow_status <> 'awaiting_payer_review'
       or transaction.issue_status <> 'none'
       or transaction.review_deadline is null
       or transition_at >= transaction.review_deadline then
      raise exception 'The review period ended or this campaign is no longer awaiting confirmation.';
    end if;
  elsif release_mode = 'automatic' then
    if transaction.workflow_status <> 'awaiting_payer_review'
       or transaction.issue_status <> 'none'
       or transaction.review_deadline is null
       or transition_at < transaction.review_deadline then
      raise exception 'This payout is not due for automatic release.';
    end if;
  elsif release_mode = 'staff' then
    if not exists (
      select 1 from public.staff_members staff
      where staff.auth_user_id = staff_user_id and staff.active
        and staff.role in ('payments_admin', 'admin')
    ) then raise exception 'Payments staff authorization is required.'; end if;
    if transaction.issue_status <> 'escalated'
       or transaction.workflow_status <> 'issue_escalated' then
      raise exception 'Only an escalated issue can be released by staff.';
    end if;
  elsif release_mode = 'partial_refund_resolution' then
    if not exists (
      select 1 from public.payment_resolution_actions resolution
      where resolution.transaction_id = transaction.id
        and resolution.action = 'partial_refund'
        and resolution.status = 'completed'
    ) then raise exception 'The partial refund must complete before payout release.'; end if;
  else
    raise exception 'Unknown payout release mode.';
  end if;

  if transaction.payout_status not in ('pending', 'blocked', 'partially_refunded') then
    raise exception 'This payout is not available for release.';
  end if;
  from_state := transaction.workflow_status;
  update public.payment_transactions
  set payout_status = 'releasing', payout_release_claimed_at = transition_at,
      payout_release_reason = release_mode, payout_last_error = null,
      confirmed_at = case when release_mode = 'payer_confirmation'
        then coalesce(confirmed_at, transition_at) else confirmed_at end,
      issue_status = case when release_mode in ('staff', 'partial_refund_resolution')
        then 'resolution_pending' else issue_status end
  where id = transaction.id returning * into transaction;

  insert into public.payment_fulfillment_events (
    transaction_id, actor_profile_id, actor_kind, event_type, from_state, to_state,
    metadata
  ) values (
    transaction.id, actor_profile_id,
    case when release_mode = 'automatic' then 'system'
         when release_mode in ('staff', 'partial_refund_resolution') then 'staff'
         else 'payer' end,
    'payout_release_claimed', from_state, from_state,
    jsonb_build_object('release_mode', release_mode)
  );
  return jsonb_build_object('already_released', false, 'should_transfer', true, 'transaction', to_jsonb(transaction));
end;
$$;

create or replace function public.claim_issue_refund_resolution(
  target_issue_id uuid,
  staff_user_id uuid,
  requested_action text,
  requested_refund_cents bigint default null,
  notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  issue public.payment_issues;
  transaction public.payment_transactions;
  resolution public.payment_resolution_actions;
  total_charge bigint;
  remaining_charge bigint;
  refund_amount bigint;
  adjusted_payout bigint;
begin
  if not exists (
    select 1 from public.staff_members staff
    where staff.auth_user_id = staff_user_id and staff.active
      and staff.role in ('payments_admin', 'admin')
  ) then raise exception 'Payments staff authorization is required.'; end if;
  if requested_action not in ('full_refund', 'partial_refund') then
    raise exception 'Choose a supported refund resolution.';
  end if;
  select * into issue from public.payment_issues where id = target_issue_id for update;
  if issue.id is null then raise exception 'Payment issue not found.'; end if;
  select * into transaction from public.payment_transactions
  where id = issue.transaction_id for update;
  if transaction.id is null then raise exception 'Payment transaction not found.'; end if;
  select * into issue from public.payment_issues where id = target_issue_id for update;
  if issue.id is null then raise exception 'Payment issue not found.'; end if;
  select * into resolution from public.payment_resolution_actions
  where issue_id = issue.id;
  if resolution.id is not null then
    return jsonb_build_object('duplicate', true, 'resolution', to_jsonb(resolution), 'transaction', to_jsonb(transaction));
  end if;
  if issue.status <> 'escalated' or transaction.payout_status <> 'blocked' then
    raise exception 'Only an escalated issue with a pending payout can be refunded.';
  end if;
  if transaction.stripe_charge_id is null then raise exception 'The verified Stripe charge is missing.'; end if;
  total_charge := transaction.customer_total_cents + transaction.tax_cents;
  remaining_charge := total_charge - transaction.refunded_cents;
  refund_amount := case when requested_action = 'full_refund'
    then remaining_charge else requested_refund_cents end;
  if refund_amount is null or refund_amount <= 0 or refund_amount > remaining_charge then
    raise exception 'Refund amount is outside the remaining customer charge.';
  end if;
  if requested_action = 'partial_refund' and refund_amount >= remaining_charge then
    raise exception 'Use full refund when returning the entire remaining charge.';
  end if;
  adjusted_payout := floor(
    transaction.creator_payout_cents::numeric
    * (total_charge - transaction.refunded_cents - refund_amount)::numeric
    / nullif(total_charge, 0)::numeric
  )::bigint;
  if requested_action = 'partial_refund' and adjusted_payout <= 0 then
    raise exception 'The remaining Creator payout is below one cent; use a full refund.';
  end if;

  insert into public.payment_resolution_actions (
    issue_id, transaction_id, staff_auth_user_id, action, refund_amount_cents,
    idempotency_key
  ) values (
    issue.id, transaction.id, staff_user_id, requested_action, refund_amount,
    'sidespace-issue-refund-' || issue.id::text
  ) returning * into resolution;
  update public.payment_issues
  set status = 'resolution_pending', resolution_action = requested_action,
      resolution_notes = trim(notes)
  where id = issue.id;
  update public.payment_transactions
  set issue_status = 'resolution_pending', workflow_status = 'refund_pending',
      payout_status = 'blocked',
      payout_amount_cents = case when requested_action = 'partial_refund'
        then adjusted_payout else 0 end
  where id = transaction.id returning * into transaction;
  return jsonb_build_object('duplicate', false, 'resolution', to_jsonb(resolution), 'transaction', to_jsonb(transaction));
end;
$$;

create or replace function public.finalize_campaign_payout_release(
  target_transaction_id uuid,
  transfer_id text,
  transferred_amount_cents bigint
)
returns public.payment_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction public.payment_transactions;
  transition_at timestamptz := clock_timestamp();
  from_state text;
begin
  select * into transaction from public.payment_transactions
  where id = target_transaction_id for update;
  if transaction.id is null then raise exception 'Payment transaction not found.'; end if;
  if transfer_id is null or btrim(transfer_id) = '' then
    raise exception 'A Stripe transfer ID is required to finalize the payout.';
  end if;
  if transaction.payout_status = 'released' then
    if transaction.stripe_transfer_id is null
       or transaction.stripe_transfer_id <> transfer_id then
      raise exception 'A different transfer already released this payout.';
    end if;
    return transaction;
  end if;
  if transaction.payout_status <> 'releasing' then
    raise exception 'The payout must be claimed before it can be finalized.';
  end if;
  if transaction.payout_amount_cents <> transferred_amount_cents then
    raise exception 'The Stripe transfer amount does not match the trusted ledger.';
  end if;
  from_state := transaction.workflow_status;
  update public.payment_transactions
  set payout_status = 'released', stripe_transfer_id = transfer_id,
      payout_released_at = transition_at, workflow_status = 'completed',
      issue_status = case when issue_status = 'none' then 'none' else 'resolved' end,
      payout_last_error = null
  where id = transaction.id returning * into transaction;
  update public.campaign_requests set status = 'completed'
  where id = transaction.campaign_request_id;
  update public.payment_issues
  set status = 'resolved', resolved_at = transition_at,
      resolution_action = coalesce(resolution_action, 'release_payout')
  where transaction_id = transaction.id and status <> 'resolved';
  insert into public.payment_fulfillment_events (
    transaction_id, actor_kind, event_type, from_state, to_state,
    metadata
  ) values (
    transaction.id, 'stripe', 'payout_released', from_state, 'completed',
    jsonb_build_object('stripe_transfer_id', transfer_id, 'amount_cents', transferred_amount_cents)
  );
  return transaction;
end;
$$;

create or replace function public.record_campaign_payout_release_failure(
  target_transaction_id uuid,
  error_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.payment_transactions
  set payout_status = case when issue_status = 'none' then 'pending' else 'blocked' end,
      issue_status = case
        when payout_release_reason = 'staff'
          and issue_status = 'resolution_pending' then 'escalated'
        else issue_status
      end,
      payout_last_error = left(error_message, 1000)
  where id = target_transaction_id and payout_status = 'releasing';
end;
$$;

-- Canonicalize the listing-cap trigger name left by the alternate lineage.
drop trigger if exists listings_enforce_cap on public.listings;
drop trigger if exists listings_cap_per_member on public.listings;
create trigger listings_cap_per_member
  before insert on public.listings
  for each row execute function public.enforce_listing_cap();

-- Browser roles must have only the data privileges used by the client. RLS
-- remains the row-level boundary; these grants close the alternate lineage's
-- table-wide privileges and prevent new functions/tables from being public by
-- default.
revoke all on table public.creator_reviews from public, anon, authenticated;
grant select on table public.creator_reviews to anon, authenticated;
grant all on table public.creator_reviews to service_role;

revoke all on table public.creator_portfolio_items from public, anon, authenticated;
grant select on table public.creator_portfolio_items to anon, authenticated;
grant insert, update, delete on table public.creator_portfolio_items to authenticated;
grant all on table public.creator_portfolio_items to service_role;

revoke all on table public.campaign_requests from public, anon, authenticated;
grant select, insert on table public.campaign_requests to authenticated;
grant all on table public.campaign_requests to service_role;

revoke all on table public.conversations from public, anon, authenticated;
grant select, insert on table public.conversations to authenticated;
grant all on table public.conversations to service_role;

revoke all on table public.listings from public, anon, authenticated;
grant all on table public.listings to authenticated;
grant all on table public.listings to service_role;

revoke all on table public.messages from public, anon, authenticated;
grant select, insert, update on table public.messages to authenticated;
grant all on table public.messages to service_role;

revoke all on table public.profile_blocks from public, anon, authenticated;
grant select, insert, delete on table public.profile_blocks to authenticated;
grant all on table public.profile_blocks to service_role;

revoke all on table public.profile_contacts from public, anon, authenticated;
grant select, insert, update on table public.profile_contacts to authenticated;
grant all on table public.profile_contacts to service_role;

revoke all on table public.profile_reports from public, anon, authenticated;
grant select, insert on table public.profile_reports to authenticated;
grant all on table public.profile_reports to service_role;

revoke all on table public.profiles from public, anon, authenticated;
grant select, insert, update on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

revoke all on table public.verification_requests from public, anon, authenticated;
grant select, insert on table public.verification_requests to authenticated;
grant all on table public.verification_requests to service_role;

-- Column grants survive a table-level revoke in PostgreSQL. Clear anonymous
-- column ACLs before restoring only the public profile/listing projections;
-- this keeps street_address and future private columns out of direct REST.
do $$
declare
  column_name text;
begin
  for column_name in
    select columns.column_name
    from information_schema.columns
    where columns.table_schema = 'public'
      and columns.table_name = 'profiles'
  loop
    execute format(
      'revoke select (%I) on table public.profiles from public, anon, authenticated',
      column_name
    );
  end loop;
  for column_name in
    select columns.column_name
    from information_schema.columns
    where columns.table_schema = 'public'
      and columns.table_name = 'listings'
  loop
    execute format(
      'revoke select (%I) on table public.listings from public, anon, authenticated',
      column_name
    );
  end loop;
end;
$$;

grant select (
  id, role, display_name, handle, bio, city, categories, followers, avg_views,
  reach_unit, audience_age, website, avatar_url, verified, is_demo, is_internal,
  onboarding_complete, extra_roles, social_links, gallery_urls, created_at,
  updated_at
) on table public.profiles to anon;

grant select (
  id, owner_profile_id, title, channel, format, price_cents, price_unit,
  description, demographics, image_url, status, created_at, updated_at,
  image_urls, location_area, availability_notes, available_from, available_to,
  lead_time_days, minimum_booking, deliverables, cancellation_policy,
  price_max_cents, brief_scope, target_platforms, surface_types, install_by,
  space_size, sponsor_tier, sponsor_slots, provenance_status,
  availability_confirmed_at
) on table public.listings to anon;

-- The fulfillment-event identity sequence is server-only. The old lineage
-- granted it to browser roles, which was unnecessary and allowed sequence
-- inspection/advancement through the Data API.
revoke all on sequence public.payment_fulfillment_events_id_seq from public, anon, authenticated;
grant all on sequence public.payment_fulfillment_events_id_seq to service_role;

-- Remove direct execution of trigger-only or server-only functions exposed by
-- the alternate lineage. Trigger execution itself is unaffected.
revoke all on function public.bump_conversation_after_message() from public, anon, authenticated, service_role;
revoke all on function public.enforce_listing_cap() from public, anon, authenticated, service_role;
revoke all on function public.invite_prospect(uuid) from public, service_role;
grant execute on function public.invite_prospect(uuid) to anon, authenticated;
revoke all on function public.link_campaign_request_conversation(uuid, uuid) from service_role;
revoke all on function public.messages_read_receipt_only() from public, anon, authenticated, service_role;
revoke all on function public.on_message_notify() from public, anon, authenticated, service_role;
revoke all on function public.on_request_notify() from public, anon, authenticated, service_role;
revoke all on function public.on_request_answered_notify() from public, anon, authenticated, service_role;
revoke all on function public.protect_profile_trust_fields() from public, anon, authenticated, service_role;
revoke all on function public.reply_from_demo_profile() from public, anon, authenticated, service_role;
revoke all on function public.respond_campaign_request(uuid, text, bigint, text) from service_role;
revoke all on function public.set_updated_at() from public, anon, authenticated, service_role;
revoke all on function public.sync_profile_verification_status() from public, anon, authenticated, service_role;

-- Future objects require explicit browser grants. Keep server-side migrations
-- and routes fully privileged without reopening the browser surface.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on tables to service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to service_role;
