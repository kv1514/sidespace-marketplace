-- A campaign request's conversation link is the only pre-payment field the
-- browser needs to add after insert. The old UPDATE policy checked the
-- requester's identity and a few NEW values, but did not compare the rest of
-- the row with OLD. A direct PostgREST caller could therefore change the
-- listing, budget, dates, or terms before the owner accepted them, and the
-- response function would snapshot those altered terms for payment.

drop policy if exists "Requester links conversation" on public.campaign_requests;
revoke update on public.campaign_requests from authenticated;

create or replace function public.link_campaign_request_conversation(
  target_request_id uuid,
  target_conversation_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  own_profile_id uuid;
  current_request public.campaign_requests;
  linked_request_id uuid;
begin
  select id into own_profile_id
  from public.profiles
  where auth_user_id = (select auth.uid())
  limit 1;

  if own_profile_id is null then
    raise exception 'You need a profile to link a campaign conversation.';
  end if;

  select * into current_request
  from public.campaign_requests
  where id = target_request_id
  for update;

  if current_request.id is null then
    raise exception 'Campaign request not found.';
  end if;
  if current_request.requester_profile_id <> own_profile_id then
    raise exception 'Only the requester can link this campaign conversation.';
  end if;

  -- Make retries idempotent, but never let a requester replace a link with a
  -- different conversation.
  if current_request.conversation_id is not null then
    if current_request.conversation_id = target_conversation_id then
      return current_request.id;
    end if;
    raise exception 'This campaign request is already linked to another conversation.';
  end if;

  if current_request.status <> 'pending'
     or current_request.counter_budget_cents is not null
     or current_request.counter_message <> ''
     or current_request.accepted_subtotal_cents is not null
     or current_request.payer_profile_id is not null
     or current_request.payee_profile_id is not null then
    raise exception 'Only a new pending campaign request can be linked.';
  end if;

  if not exists (
    select 1
    from public.conversations conversation
    where conversation.id = target_conversation_id
      and (
        (conversation.participant_a = own_profile_id
          and conversation.participant_b = current_request.owner_profile_id)
        or
        (conversation.participant_b = own_profile_id
          and conversation.participant_a = current_request.owner_profile_id)
      )
  ) then
    raise exception 'The conversation must be between the requester and listing owner.';
  end if;

  update public.campaign_requests
  set conversation_id = target_conversation_id
  where id = current_request.id
    and conversation_id is null
  returning id into linked_request_id;

  if linked_request_id is null then
    raise exception 'Campaign request link changed; try again.';
  end if;
  return linked_request_id;
end;
$$;

revoke all on function public.link_campaign_request_conversation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.link_campaign_request_conversation(uuid, uuid)
  to authenticated;
