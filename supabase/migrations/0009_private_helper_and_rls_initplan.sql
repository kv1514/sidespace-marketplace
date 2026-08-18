-- Two problems flagged by Supabase's own database linter.
--
-- 1. SECURITY. blocked_between() lived in `public` as a SECURITY DEFINER
--    function, so PostgREST served it at /rest/v1/rpc/blocked_between. Any
--    signed-in member could therefore ask whether ANY two members had blocked
--    each other, and profile ids are public, so the whole block graph was
--    enumerable. It moves to a `private` schema that PostgREST does not serve;
--    the RLS policies can still call it, the HTTP endpoint disappears.
--
-- 2. PERFORMANCE. Seventeen policies called auth.uid() bare, which Postgres
--    re-evaluates once per row scanned (the auth_rls_initplan lint). Wrapping
--    it in a scalar subquery evaluates it once per query instead. Semantics are
--    unchanged in every case.
--
-- Idempotent and matches production, so re-applying is a no-op.

create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.blocked_between(profile_a uuid, profile_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profile_blocks
    where (blocker_profile_id = profile_a and blocked_profile_id = profile_b)
       or (blocker_profile_id = profile_b and blocked_profile_id = profile_a)
  );
$$;

drop policy if exists "Members create campaign requests" on public.campaign_requests;
create policy "Members create campaign requests"
on public.campaign_requests for insert to authenticated
with check (
  status = 'pending'
  and counter_budget is null
  and counter_message = ''
  and requester_profile_id <> owner_profile_id
  and not private.blocked_between(requester_profile_id, owner_profile_id)
  and exists (
    select 1 from public.profiles
    where profiles.id = campaign_requests.requester_profile_id
      and profiles.auth_user_id = (select auth.uid())
      and profiles.onboarding_complete
  )
  and exists (
    select 1 from public.listings
    where listings.id = campaign_requests.listing_id
      and listings.owner_profile_id = campaign_requests.owner_profile_id
      and listings.status = 'active'
  )
);

drop policy if exists "Participants start conversations" on public.conversations;
create policy "Participants start conversations"
on public.conversations for insert to authenticated
with check (
  participant_a::text < participant_b::text
  and not private.blocked_between(participant_a, participant_b)
  and exists (
    select 1 from public.profiles
    where profiles.auth_user_id = (select auth.uid())
      and profiles.id in (conversations.participant_a, conversations.participant_b)
      and profiles.onboarding_complete
  )
);

drop policy if exists "Participants send messages" on public.messages;
create policy "Participants send messages"
on public.messages for insert to authenticated
with check (
  exists (
    select 1
    from public.profiles sender
    join public.conversations on conversations.id = messages.conversation_id
    where sender.id = messages.sender_profile_id
      and sender.auth_user_id = (select auth.uid())
      and (sender.id = conversations.participant_a or sender.id = conversations.participant_b)
      and not private.blocked_between(conversations.participant_a, conversations.participant_b)
  )
);

drop function if exists public.blocked_between(uuid, uuid);

drop policy if exists "Campaign participants read requests" on public.campaign_requests;
create policy "Campaign participants read requests"
on public.campaign_requests for select to authenticated
using (exists (select 1 from public.profiles
  where profiles.auth_user_id = (select auth.uid())
    and profiles.id = any (array[campaign_requests.requester_profile_id, campaign_requests.owner_profile_id])));

drop policy if exists "Participants read conversations" on public.conversations;
create policy "Participants read conversations"
on public.conversations for select to authenticated
using (exists (select 1 from public.profiles
  where profiles.auth_user_id = (select auth.uid())
    and profiles.id = any (array[conversations.participant_a, conversations.participant_b])));

drop policy if exists "Participants read messages" on public.messages;
create policy "Participants read messages"
on public.messages for select to authenticated
using (exists (select 1 from public.conversations
  join public.profiles on profiles.id = conversations.participant_a or profiles.id = conversations.participant_b
  where conversations.id = messages.conversation_id
    and profiles.auth_user_id = (select auth.uid())));

drop policy if exists "Active listings are public" on public.listings;
create policy "Active listings are public"
on public.listings for select
using (status = 'active' or exists (select 1 from public.profiles
  where profiles.id = listings.owner_profile_id and profiles.auth_user_id = (select auth.uid())));

drop policy if exists "Members create their own listings" on public.listings;
create policy "Members create their own listings"
on public.listings for insert to authenticated
with check (exists (select 1 from public.profiles
  where profiles.id = listings.owner_profile_id
    and profiles.auth_user_id = (select auth.uid())
    and profiles.onboarding_complete
    and profiles.role <> 'consumer'));

drop policy if exists "Members update their own listings" on public.listings;
create policy "Members update their own listings"
on public.listings for update to authenticated
using (exists (select 1 from public.profiles
  where profiles.id = listings.owner_profile_id and profiles.auth_user_id = (select auth.uid())))
with check (exists (select 1 from public.profiles
  where profiles.id = listings.owner_profile_id and profiles.auth_user_id = (select auth.uid())));

drop policy if exists "Members delete their own listings" on public.listings;
create policy "Members delete their own listings"
on public.listings for delete to authenticated
using (exists (select 1 from public.profiles
  where profiles.id = listings.owner_profile_id and profiles.auth_user_id = (select auth.uid())));

drop policy if exists "Profiles are publicly readable" on public.profiles;
create policy "Profiles are publicly readable"
on public.profiles for select
using (onboarding_complete or auth_user_id = (select auth.uid()));

drop policy if exists "Members create their own profile" on public.profiles;
create policy "Members create their own profile"
on public.profiles for insert to authenticated
with check (auth_user_id = (select auth.uid()) and not is_demo);

drop policy if exists "Members update their own profile" on public.profiles;
create policy "Members update their own profile"
on public.profiles for update to authenticated
using (auth_user_id = (select auth.uid()))
with check (auth_user_id = (select auth.uid()) and not is_demo);

drop policy if exists "Members read their blocks" on public.profile_blocks;
create policy "Members read their blocks"
on public.profile_blocks for select to authenticated
using (exists (select 1 from public.profiles
  where profiles.id = profile_blocks.blocker_profile_id and profiles.auth_user_id = (select auth.uid())));

drop policy if exists "Members block profiles" on public.profile_blocks;
create policy "Members block profiles"
on public.profile_blocks for insert to authenticated
with check (exists (select 1 from public.profiles
  where profiles.id = profile_blocks.blocker_profile_id and profiles.auth_user_id = (select auth.uid())));

drop policy if exists "Members remove their blocks" on public.profile_blocks;
create policy "Members remove their blocks"
on public.profile_blocks for delete to authenticated
using (exists (select 1 from public.profiles
  where profiles.id = profile_blocks.blocker_profile_id and profiles.auth_user_id = (select auth.uid())));

drop policy if exists "Members submit profile reports" on public.profile_reports;
create policy "Members submit profile reports"
on public.profile_reports for insert to authenticated
with check (status = 'open' and exists (select 1 from public.profiles
  where profiles.id = profile_reports.reporter_profile_id and profiles.auth_user_id = (select auth.uid())));

drop policy if exists "Members read their submitted reports" on public.profile_reports;
create policy "Members read their submitted reports"
on public.profile_reports for select to authenticated
using (exists (select 1 from public.profiles
  where profiles.id = profile_reports.reporter_profile_id and profiles.auth_user_id = (select auth.uid())));

drop policy if exists "Members submit their verification request" on public.verification_requests;
create policy "Members submit their verification request"
on public.verification_requests for insert to authenticated
with check (status = 'pending' and exists (select 1 from public.profiles
  where profiles.id = verification_requests.profile_id
    and profiles.auth_user_id = (select auth.uid())
    and profiles.onboarding_complete
    and profiles.role <> 'consumer'));

drop policy if exists "Members read their verification request" on public.verification_requests;
create policy "Members read their verification request"
on public.verification_requests for select to authenticated
using (exists (select 1 from public.profiles
  where profiles.id = verification_requests.profile_id and profiles.auth_user_id = (select auth.uid())));
