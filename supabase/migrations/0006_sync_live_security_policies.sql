-- Captures security objects that were applied directly to the live database and
-- never written back into a migration. Without this file, rebuilding the schema
-- from supabase/migrations (a new environment, a restore, a new machine) would
-- silently produce a WEAKER database than production:
--
--   * campaign_requests inserts would accept any status, letting a member forge
--     a permanently "accepted" booking on someone else's listing;
--   * blocked members could still open campaigns with each other;
--   * nobody could mark a message read, so unread counts would never clear.
--
-- Every statement below is idempotent and matches what production already runs,
-- so applying this against the live database is a no-op.

-- Blocking check used by the campaign-request policy. Security definer because
-- profile_blocks is only readable by the blocker, but the policy has to see
-- blocks in BOTH directions.
create or replace function public.blocked_between(profile_a uuid, profile_b uuid)
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

-- A campaign request may only ever be BORN pending, with no counteroffer
-- attached. Every later transition goes through public.respond_campaign_request,
-- which checks who the caller is. There is deliberately no update or delete
-- policy on this table, so that function is the only way a status can change.
drop policy if exists "Members create campaign requests" on public.campaign_requests;
create policy "Members create campaign requests"
on public.campaign_requests for insert
to authenticated
with check (
  status = 'pending'
  and counter_budget is null
  and counter_message = ''
  and requester_profile_id <> owner_profile_id
  and not public.blocked_between(requester_profile_id, owner_profile_id)
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

-- Read receipts: you may mark messages read in a conversation you belong to,
-- but never your own messages (which would let you fake the other side reading).
drop policy if exists "Recipients mark messages read" on public.messages;
create policy "Recipients mark messages read"
on public.messages for update
to authenticated
using (
  sender_profile_id <> (
    select profiles.id from public.profiles
    where profiles.auth_user_id = (select auth.uid())
  )
  and exists (
    select 1
    from public.conversations
    join public.profiles
      on profiles.id = conversations.participant_a
      or profiles.id = conversations.participant_b
    where conversations.id = messages.conversation_id
      and profiles.auth_user_id = (select auth.uid())
  )
)
with check (
  sender_profile_id <> (
    select profiles.id from public.profiles
    where profiles.auth_user_id = (select auth.uid())
  )
);

-- The UPDATE policy above gates WHO may touch a row, but RLS WITH CHECK cannot
-- see OLD, so it cannot gate WHICH COLUMNS changed. Without this trigger either
-- participant could rewrite the other member's message body - forging what was
-- agreed in the thread a booking is negotiated in - or move their message into
-- an unrelated conversation. The only legitimate update the app performs sets
-- read_at, so pinning every other column breaks nothing.
create or replace function public.messages_read_receipt_only()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.conversation_id is distinct from old.conversation_id
     or new.sender_profile_id is distinct from old.sender_profile_id
     or new.body is distinct from old.body
     or new.created_at is distinct from old.created_at then
    raise exception 'messages may only be updated to set read_at';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_read_receipt_only on public.messages;
create trigger messages_read_receipt_only
before update on public.messages
for each row execute function public.messages_read_receipt_only();

-- Blocking must hold at the database, not just in the browse filter. Messages
-- and campaign requests already refused to cross a block in production (another
-- policy that lived only on the live database); starting a CONVERSATION did
-- not, so a blocked member could still drop an empty thread into the blocker's
-- inbox. All three write paths now agree.
drop policy if exists "Participants start conversations" on public.conversations;
create policy "Participants start conversations"
on public.conversations for insert
to authenticated
with check (
  participant_a::text < participant_b::text
  and not public.blocked_between(participant_a, participant_b)
  and exists (
    select 1 from public.profiles
    where profiles.auth_user_id = (select auth.uid())
      and profiles.id in (conversations.participant_a, conversations.participant_b)
      and profiles.onboarding_complete
  )
);

drop policy if exists "Participants send messages" on public.messages;
create policy "Participants send messages"
on public.messages for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles sender
    join public.conversations on conversations.id = messages.conversation_id
    where sender.id = messages.sender_profile_id
      and sender.auth_user_id = (select auth.uid())
      and (sender.id = conversations.participant_a or sender.id = conversations.participant_b)
      and not public.blocked_between(conversations.participant_a, conversations.participant_b)
  )
);
