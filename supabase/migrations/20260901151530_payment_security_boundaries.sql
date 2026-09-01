-- Close the four boundaries identified during the pre-live payment review:
-- internal accounts, authenticated table-wide reads, mutable campaign
-- direction, and refund/dispute payout reconciliation.

-- ---------------------------------------------------------------------------
-- Public and owner-scoped data projections
-- ---------------------------------------------------------------------------

create or replace function private.profile_is_internal(target_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select profile.is_internal
    from public.profiles profile
    where profile.id = target_profile_id
  ), false);
$$;

create or replace function private.profile_owned_by_current_user(target_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = target_profile_id
      and profile.auth_user_id = (select auth.uid())
  );
$$;

grant usage on schema private to anon, authenticated;
revoke all on function private.profile_is_internal(uuid) from public;
revoke all on function private.profile_owned_by_current_user(uuid) from public;
grant execute on function private.profile_is_internal(uuid) to anon, authenticated;
grant execute on function private.profile_owned_by_current_user(uuid) to anon, authenticated;

-- A public projection has an explicit internal-account predicate and never
-- includes the internal marker or trust/authentication columns in its result.
-- security_invoker keeps the base table's RLS and column privileges active.
drop view if exists public.marketplace_profiles;
create view public.marketplace_profiles
with (security_invoker = true, security_barrier = true)
as
select
  profile.id,
  profile.role,
  profile.display_name,
  profile.handle,
  profile.bio,
  profile.city,
  profile.categories,
  profile.followers,
  profile.avg_views,
  profile.reach_unit,
  profile.audience_age,
  profile.website,
  profile.avatar_url,
  profile.verified,
  profile.is_demo,
  profile.onboarding_complete,
  profile.extra_roles,
  profile.social_links,
  profile.gallery_urls,
  profile.created_at,
  profile.updated_at
from public.profiles profile
where profile.onboarding_complete
  and not profile.is_internal;

-- These projections are deliberately owner-scoped. They are the only browser
-- reads that return fields needed for editing, such as auth_user_id,
-- verification state, social verification, and a physical listing address.
-- The owner predicate is inside a security-barrier view because PostgreSQL
-- column grants cannot express an owner-only projection on the base table.
drop view if exists public.my_profiles;
create view public.my_profiles
with (security_barrier = true)
as
select profile.*
from public.profiles profile
where profile.auth_user_id = (select auth.uid());

drop view if exists public.my_listings;
create view public.my_listings
with (security_barrier = true)
as
select listing.*
from public.listings listing
where exists (
  select 1
  from public.profiles profile
  where profile.id = listing.owner_profile_id
    and profile.auth_user_id = (select auth.uid())
);

revoke all on table public.marketplace_profiles, public.my_profiles, public.my_listings
  from public, anon, authenticated;
grant select on table public.marketplace_profiles to anon, authenticated;
grant select on table public.my_profiles, public.my_listings to authenticated;

-- No browser role keeps a table-wide SELECT privilege. The two owner views
-- above are the narrow path for private fields; base-table reads are limited
-- to the explicit public projections below.
revoke all on table public.profiles from public, anon, authenticated;
grant insert, update on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

revoke all on table public.listings from public, anon, authenticated;
grant insert, update, delete on table public.listings to authenticated;
grant all on table public.listings to service_role;

do $$
declare
  target_table text;
  column_name text;
begin
  for target_table in select unnest(array['profiles', 'listings']::text[]) loop
    for column_name in
      select columns.column_name
      from information_schema.columns columns
      where columns.table_schema = 'public'
        and columns.table_name = target_table
    loop
      execute format(
        'revoke select (%I) on table public.%I from public, anon, authenticated',
        column_name,
        target_table
      );
    end loop;
  end loop;
end;
$$;

grant select (
  id, role, display_name, handle, bio, city, categories, followers, avg_views,
  reach_unit, audience_age, website, avatar_url, verified, is_demo,
  onboarding_complete, extra_roles, social_links, gallery_urls, created_at,
  updated_at, is_internal
) on table public.profiles to anon, authenticated;

grant select (
  id, owner_profile_id, title, channel, format, price_cents, price_unit,
  description, demographics, image_url, status, created_at, updated_at,
  image_urls, location_area, availability_notes, available_from, available_to,
  lead_time_days, minimum_booking, deliverables, cancellation_policy,
  price_max_cents, brief_scope, target_platforms, surface_types, install_by,
  space_size, sponsor_tier, sponsor_slots, provenance_status,
  availability_confirmed_at
) on table public.listings to anon, authenticated;

comment on view public.marketplace_profiles is
  'Safe public profile projection. Internal profiles are excluded by the view predicate and base-table RLS.';
comment on view public.my_profiles is
  'Owner-only profile projection. Do not grant access to anon or broaden the auth.uid predicate.';
comment on view public.my_listings is
  'Owner-only listing projection. Includes the physical address only for the authenticated listing owner.';

-- ---------------------------------------------------------------------------
-- Internal-account exclusion at the database boundary
-- ---------------------------------------------------------------------------

drop policy if exists "Profiles are publicly readable" on public.profiles;
create policy "Profiles are publicly readable"
on public.profiles for select
using (
  (onboarding_complete and not private.profile_is_internal(id))
  or private.profile_owned_by_current_user(id)
);

drop policy if exists "Active listings are public" on public.listings;
create policy "Active listings are public"
on public.listings for select
using (
  (status = 'active' and not private.profile_is_internal(owner_profile_id))
  or private.profile_owned_by_current_user(owner_profile_id)
);

-- This policy was introduced by the remote-only 20260901080846 lineage. The
-- owner projection below replaces it, and the base table no longer grants
-- browser SELECT, so leave no alternate read path behind after reconciliation.
drop policy if exists "Members read their own listings" on public.listings;

drop policy if exists "Members create their own listings" on public.listings;
create policy "Members create their own listings"
on public.listings for insert to authenticated
with check (
  private.profile_owned_by_current_user(owner_profile_id)
  and not private.profile_is_internal(owner_profile_id)
  and exists (
    select 1 from public.profiles profile
    where profile.id = listings.owner_profile_id
      and profile.onboarding_complete
      and profile.role <> 'consumer'
  )
);

drop policy if exists "Members update their own listings" on public.listings;
create policy "Members update their own listings"
on public.listings for update to authenticated
using (private.profile_owned_by_current_user(owner_profile_id))
with check (private.profile_owned_by_current_user(owner_profile_id));

drop policy if exists "Members delete their own listings" on public.listings;
create policy "Members delete their own listings"
on public.listings for delete to authenticated
using (private.profile_owned_by_current_user(owner_profile_id));

drop policy if exists "Campaign participants read requests" on public.campaign_requests;
create policy "Campaign participants read requests"
on public.campaign_requests for select to authenticated
using (
  not private.profile_is_internal(requester_profile_id)
  and not private.profile_is_internal(owner_profile_id)
  and (
    private.profile_owned_by_current_user(requester_profile_id)
    or private.profile_owned_by_current_user(owner_profile_id)
  )
);

drop policy if exists "Members create campaign requests" on public.campaign_requests;
create policy "Members create campaign requests"
on public.campaign_requests for insert to authenticated
with check (
  status = 'pending'
  and counter_budget_cents is null
  and counter_message = ''
  and accepted_subtotal_cents is null
  and payer_profile_id is null
  and payee_profile_id is null
  and requester_profile_id <> owner_profile_id
  and not private.profile_is_internal(requester_profile_id)
  and not private.profile_is_internal(owner_profile_id)
  and not private.blocked_between(requester_profile_id, owner_profile_id)
  and private.profile_owned_by_current_user(requester_profile_id)
  and exists (
    select 1 from public.profiles profile
    where profile.id = campaign_requests.requester_profile_id
      and profile.onboarding_complete
  )
  and exists (
    select 1 from public.listings listing
    where listing.id = campaign_requests.listing_id
      and listing.owner_profile_id = campaign_requests.owner_profile_id
      and listing.status = 'active'
      and listing.provenance_status in ('owner_attested', 'staff_verified')
      and listing.availability_confirmed_at >= now() - interval '90 days'
      and not private.profile_is_internal(listing.owner_profile_id)
  )
);

drop policy if exists "Participants read conversations" on public.conversations;
create policy "Participants read conversations"
on public.conversations for select to authenticated
using (
  not private.profile_is_internal(participant_a)
  and not private.profile_is_internal(participant_b)
  and (
    private.profile_owned_by_current_user(participant_a)
    or private.profile_owned_by_current_user(participant_b)
  )
);

drop policy if exists "Participants start conversations" on public.conversations;
create policy "Participants start conversations"
on public.conversations for insert to authenticated
with check (
  participant_a::text < participant_b::text
  and not private.profile_is_internal(participant_a)
  and not private.profile_is_internal(participant_b)
  and not private.blocked_between(participant_a, participant_b)
  and (
    private.profile_owned_by_current_user(participant_a)
    or private.profile_owned_by_current_user(participant_b)
  )
  and exists (
    select 1 from public.profiles profile
    where profile.id in (conversations.participant_a, conversations.participant_b)
      and profile.onboarding_complete
  )
);

drop policy if exists "Participants read messages" on public.messages;
create policy "Participants read messages"
on public.messages for select to authenticated
using (
  exists (
    select 1
    from public.conversations conversation
    where conversation.id = messages.conversation_id
      and not private.profile_is_internal(conversation.participant_a)
      and not private.profile_is_internal(conversation.participant_b)
      and (
        private.profile_owned_by_current_user(conversation.participant_a)
        or private.profile_owned_by_current_user(conversation.participant_b)
      )
  )
);

drop policy if exists "Participants send messages" on public.messages;
create policy "Participants send messages"
on public.messages for insert to authenticated
with check (
  not private.profile_is_internal(sender_profile_id)
  and exists (
    select 1
    from public.conversations conversation
    where conversation.id = messages.conversation_id
      and not private.profile_is_internal(conversation.participant_a)
      and not private.profile_is_internal(conversation.participant_b)
      and (
        conversation.participant_a = messages.sender_profile_id
        or conversation.participant_b = messages.sender_profile_id
      )
      and private.profile_owned_by_current_user(messages.sender_profile_id)
      and not private.blocked_between(conversation.participant_a, conversation.participant_b)
  )
);

drop policy if exists "Recipients mark messages read" on public.messages;
create policy "Recipients mark messages read"
on public.messages for update to authenticated
using (
  not private.profile_is_internal(sender_profile_id)
  and sender_profile_id <> (
    select profile.id from public.profiles profile
    where private.profile_owned_by_current_user(profile.id)
  )
  and exists (
    select 1
    from public.conversations conversation
    where conversation.id = messages.conversation_id
      and not private.profile_is_internal(conversation.participant_a)
      and not private.profile_is_internal(conversation.participant_b)
      and (
        private.profile_owned_by_current_user(conversation.participant_a)
        or private.profile_owned_by_current_user(conversation.participant_b)
      )
  )
)
with check (
  not private.profile_is_internal(sender_profile_id)
  and sender_profile_id <> (
    select profile.id from public.profiles profile
    where private.profile_owned_by_current_user(profile.id)
  )
);

create or replace function private.reject_internal_conversation_participants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.profile_is_internal(new.participant_a)
     or private.profile_is_internal(new.participant_b) then
    raise exception 'Internal profiles cannot participate in conversations.';
  end if;
  return new;
end;
$$;

drop trigger if exists conversations_reject_internal_participants on public.conversations;
create trigger conversations_reject_internal_participants
before insert or update of participant_a, participant_b on public.conversations
for each row execute function private.reject_internal_conversation_participants();

create or replace function private.reject_internal_message_participants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.profile_is_internal(new.sender_profile_id)
     or exists (
       select 1
       from public.conversations conversation
       where conversation.id = new.conversation_id
         and (
           private.profile_is_internal(conversation.participant_a)
           or private.profile_is_internal(conversation.participant_b)
         )
     ) then
    raise exception 'Internal profiles cannot send messages.';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_reject_internal_participants on public.messages;
create trigger messages_reject_internal_participants
before insert on public.messages
for each row execute function private.reject_internal_message_participants();

revoke all on function private.reject_internal_conversation_participants() from public, anon, authenticated;
revoke all on function private.reject_internal_message_participants() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Freeze economic direction while a request is negotiable
-- ---------------------------------------------------------------------------

create or replace function private.prevent_listing_channel_change_with_pending_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.channel is distinct from old.channel
     and exists (
       select 1
       from public.campaign_requests request
       where request.listing_id = old.id
         and request.status in ('pending', 'countered')
     ) then
    raise exception 'A listing channel cannot change while a campaign request is pending.';
  end if;
  return new;
end;
$$;

drop trigger if exists listings_freeze_channel_for_pending_requests on public.listings;
create trigger listings_freeze_channel_for_pending_requests
before update of channel on public.listings
for each row execute function private.prevent_listing_channel_change_with_pending_request();

revoke all on function private.prevent_listing_channel_change_with_pending_request()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Never release a non-reconciled refunded payout
-- ---------------------------------------------------------------------------

create or replace function private.prevent_unreconciled_refund_payout_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.payout_status = 'releasing'
     and coalesce(new.refunded_cents, 0) > 0
     and new.payout_release_reason <> 'partial_refund_resolution' then
    raise exception 'A refunded payout requires staff resolution before release.';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_transactions_refund_release_guard on public.payment_transactions;
create trigger payment_transactions_refund_release_guard
before update on public.payment_transactions
for each row execute function private.prevent_unreconciled_refund_payout_release();

revoke all on function private.prevent_unreconciled_refund_payout_release()
  from public, anon, authenticated;
