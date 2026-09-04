-- Founder Slack commands for moderation: suspend a member, and blocklist a
-- string from listing titles and descriptions.
--
-- The suspension column, the blocklist table and its trigger already exist
-- (account_suspension_and_moderation_blocklist). This adds the audited,
-- retry-safe RPCs behind them so moderation happens from Slack rather than a
-- hand-written UPDATE against production.
--
-- Both follow the credit/referral pattern in 20260902060000: advisory lock on
-- the Slack action key, replay returns the recorded result, and the mutation
-- plus its audit row commit together.

-- ── audit table: make room for actions that move no money ──────────────────
alter table private.slack_admin_actions
  add column if not exists pattern text;

alter table private.slack_admin_actions
  drop constraint if exists slack_admin_actions_action_type_check;
alter table private.slack_admin_actions
  add constraint slack_admin_actions_action_type_check
  check (action_type in (
    'credit_grant', 'referral_create',
    'member_suspend', 'member_restore',
    'pattern_block', 'pattern_unblock'
  ));

-- amount_cents was NOT NULL with a 100..500000 range. Moderation carries no
-- amount, so it becomes nullable and the range applies only when present.
alter table private.slack_admin_actions
  alter column amount_cents drop not null;
alter table private.slack_admin_actions
  drop constraint if exists slack_admin_actions_amount_cents_check;
alter table private.slack_admin_actions
  add constraint slack_admin_actions_amount_cents_check
  check (amount_cents is null or amount_cents between 100 and 500000);

alter table private.slack_admin_actions
  drop constraint if exists slack_admin_action_shape;
alter table private.slack_admin_actions
  add constraint slack_admin_action_shape check (
    (action_type = 'credit_grant' and target_email is not null
      and target_profile_id is not null and referral_code is null
      and pattern is null and amount_cents is not null
      and char_length(btrim(reason)) between 3 and 500)
    or (action_type = 'referral_create' and target_email is null
      and target_profile_id is null and referral_code is not null
      and pattern is null and amount_cents is not null and reason is null)
    or (action_type in ('member_suspend', 'member_restore')
      and target_email is not null and target_profile_id is not null
      and referral_code is null and pattern is null and amount_cents is null)
    or (action_type in ('pattern_block', 'pattern_unblock')
      and target_email is null and target_profile_id is null
      and referral_code is null and pattern is not null and amount_cents is null)
  );

-- ── suspend / restore a member ─────────────────────────────────────────────
create or replace function public.set_member_suspension_by_email(
  target_email text,
  suspend boolean,
  suspend_reason text,
  admin_action_key text,
  slack_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text;
  target_profile public.profiles;
  existing_action private.slack_admin_actions;
  hidden_listings bigint;
  action_result jsonb;
  this_action text;
begin
  this_action := case when suspend then 'member_suspend' else 'member_restore' end;
  normalized_email := lower(btrim(target_email));

  if normalized_email = ''
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or admin_action_key !~ '^[0-9a-f]{64}$'
     or slack_user_id !~ '^[A-Z0-9]{6,32}$'
     or (suspend and char_length(btrim(coalesce(suspend_reason, ''))) not between 3 and 500) then
    raise exception 'Invalid founder moderation action.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(admin_action_key, 0)
  );
  select * into existing_action
  from private.slack_admin_actions action
  where action.action_key = admin_action_key;
  if existing_action.action_key is not null then
    if existing_action.action_type <> this_action
       or existing_action.target_email <> normalized_email
       or existing_action.slack_user_id <> set_member_suspension_by_email.slack_user_id then
      raise exception 'The Slack action key was already used for another operation.';
    end if;
    return existing_action.result;
  end if;

  select profile.* into target_profile
  from auth.users account
  join public.profiles profile on profile.auth_user_id = account.id
  where lower(btrim(account.email)) = normalized_email
  limit 1
  for update of profile;
  if target_profile.id is null then
    raise exception 'No SideSpace profile exists for that authenticated email.';
  end if;

  -- A founder cannot suspend a founder. Staff accounts are marked internal.
  if suspend and target_profile.is_internal then
    raise exception 'Internal SideSpace accounts cannot be suspended.';
  end if;

  update public.profiles
  set suspended_at = case when suspend then coalesce(suspended_at, now()) else null end,
      suspended_reason = case when suspend then btrim(suspend_reason) else null end
  where id = target_profile.id;

  select count(*) into hidden_listings
  from public.listings
  where owner_profile_id = target_profile.id and status = 'active';

  action_result := jsonb_build_object(
    'email', normalized_email,
    'profile_id', target_profile.id,
    'display_name', target_profile.display_name,
    'suspended', suspend,
    'affected_listings', hidden_listings
  );

  insert into private.slack_admin_actions (
    action_key, slack_user_id, action_type, target_email, target_profile_id,
    amount_cents, reason, result
  ) values (
    admin_action_key, set_member_suspension_by_email.slack_user_id,
    this_action, normalized_email, target_profile.id,
    null, case when suspend then btrim(suspend_reason) else null end, action_result
  );
  return action_result;
end;
$$;

-- ── add / remove a blocklist pattern ───────────────────────────────────────
create or replace function public.set_listing_blocklist_pattern(
  target_pattern text,
  block boolean,
  pattern_reason text,
  admin_action_key text,
  slack_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleaned text;
  existing_action private.slack_admin_actions;
  collateral bigint;
  collateral_titles text;
  action_result jsonb;
  this_action text;
  probe boolean;
begin
  this_action := case when block then 'pattern_block' else 'pattern_unblock' end;
  cleaned := btrim(target_pattern);

  if char_length(cleaned) < 4 or char_length(cleaned) > 200
     or admin_action_key !~ '^[0-9a-f]{64}$'
     or slack_user_id !~ '^[A-Z0-9]{6,32}$'
     or (block and char_length(btrim(coalesce(pattern_reason, ''))) not between 3 and 500) then
    raise exception 'A blocklist pattern must be 4 to 200 characters, with a reason.';
  end if;

  -- A pattern that does not compile would make the listings trigger raise on
  -- EVERY publish, for everyone. Prove it compiles before it can be stored.
  begin
    probe := ('sidespace pattern probe' ~* cleaned);
  exception when others then
    raise exception 'That is not a valid search pattern.';
  end;

  -- And a pattern that matches everything is the same outage by another route.
  if ('' ~* cleaned) then
    raise exception 'That pattern matches every listing. Use something more specific.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(admin_action_key, 0)
  );
  select * into existing_action
  from private.slack_admin_actions action
  where action.action_key = admin_action_key;
  if existing_action.action_key is not null then
    if existing_action.action_type <> this_action
       or existing_action.pattern <> cleaned
       or existing_action.slack_user_id <> set_listing_blocklist_pattern.slack_user_id then
      raise exception 'The Slack action key was already used for another operation.';
    end if;
    return existing_action.result;
  end if;

  if block then
    -- The beef jerky guard. A pattern broad enough to hit a listing from a
    -- member in good standing is refused, and says which ones, so "jerk" can
    -- never quietly take down a jerky stand or a jerk chicken window. To
    -- remove a specific member's live listing, suspend the member instead.
    select count(*), string_agg(listing.title, ' · ' order by listing.title)
      into collateral, collateral_titles
    from public.listings listing
    join public.profiles owner on owner.id = listing.owner_profile_id
    where owner.suspended_at is null
      and coalesce(listing.title, '') || ' ' || coalesce(listing.description, '') ~* cleaned;

    if collateral > 0 then
      raise exception 'That pattern would block % listing(s) from members in good standing: %',
        collateral, left(collateral_titles, 300);
    end if;

    insert into public.moderation_blocklist (pattern, reason)
    values (cleaned, btrim(pattern_reason))
    on conflict (pattern) do update set reason = excluded.reason;
  else
    delete from public.moderation_blocklist where pattern = cleaned;
  end if;

  action_result := jsonb_build_object(
    'pattern', cleaned,
    'blocked', block,
    'total_patterns', (select count(*) from public.moderation_blocklist)
  );

  insert into private.slack_admin_actions (
    action_key, slack_user_id, action_type, target_email, target_profile_id,
    amount_cents, pattern, reason, result
  ) values (
    admin_action_key, set_listing_blocklist_pattern.slack_user_id,
    this_action, null, null, null, cleaned,
    case when block then btrim(pattern_reason) else null end, action_result
  );
  return action_result;
end;
$$;

-- ── read the current blocklist ─────────────────────────────────────────────
create or replace function public.get_listing_blocklist()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'pattern', entry.pattern,
           'reason', entry.reason,
           'created_at', entry.created_at
         ) order by entry.created_at), '[]'::jsonb)
  from public.moderation_blocklist entry;
$$;

revoke all on function public.set_member_suspension_by_email(text, boolean, text, text, text)
  from public, anon, authenticated;
grant execute on function public.set_member_suspension_by_email(text, boolean, text, text, text)
  to service_role;

revoke all on function public.set_listing_blocklist_pattern(text, boolean, text, text, text)
  from public, anon, authenticated;
grant execute on function public.set_listing_blocklist_pattern(text, boolean, text, text, text)
  to service_role;

revoke all on function public.get_listing_blocklist()
  from public, anon, authenticated;
grant execute on function public.get_listing_blocklist() to service_role;
