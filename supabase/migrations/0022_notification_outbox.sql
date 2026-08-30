-- The reason this marketplace has never produced a booking.
--
-- On 2026-08-17 Troy VEX Robotics messaged Tharun Manigandan. Tharun was never
-- told. Twelve days later he still has not been, because nothing in this
-- product sends an email - not on a message, not on a placement request, not
-- on an acceptance. Sixteen members, fifteen listings, three messages ever and
-- zero bookings. Supply works; the loop that turns it into a transaction does
-- not exist.
--
-- This is the capture half of that loop, and it lives in the DATABASE rather
-- than in the client on purpose:
--
--   * A message inserted from anywhere - the app, a future mobile client, a
--     script - raises a notification. The web app does not have to remember to.
--   * The recipient's address is resolved and STORED at insert time, so a
--     later email change cannot misdeliver an old notice.
--   * Sending is a separate concern draining this outbox. That means it works
--     today through the operator's mailbox, and swaps to a real transactional
--     provider later without touching a single trigger.
create table if not exists public.notifications (
  id                   uuid primary key default gen_random_uuid(),
  recipient_profile_id uuid not null references public.profiles(id) on delete cascade,
  kind                 text not null check (kind in (
                         'message', 'request', 'request_accepted',
                         'request_declined', 'request_countered'
                       )),
  -- The conversation or request this is about. Used to avoid sending a second
  -- email for a thread the recipient has not come back to yet.
  context_id           uuid,
  email                text not null,
  subject              text not null,
  body                 text not null,
  created_at           timestamptz not null default now(),
  sent_at              timestamptz,
  attempts             integer not null default 0,
  error                text
);

create index if not exists notifications_unsent_idx
  on public.notifications (created_at)
  where sent_at is null;

-- Nobody reads this from the client. No policies are defined, so with RLS on,
-- anon and authenticated get nothing; only the service role and the
-- security-definer triggers below can touch it.
alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;

/**
 * Where a member can actually be reached.
 *
 * contact_email is optional and, as of today, null for all sixteen members -
 * so the account address is what makes this 100% deliverable rather than 0%.
 */
create or replace function public.notify_email_for(profile_id uuid)
returns text
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(nullif(p.contact_email, ''), u.email)
  from public.profiles p
  left join auth.users u on u.id = p.auth_user_id
  where p.id = profile_id;
$$;

/**
 * Queue one notification, unless the recipient already has an unsent one for
 * the same thing.
 *
 * Someone firing off four messages in a row should not put four emails in
 * somebody's inbox; the first one already says "you have a message waiting".
 */
create or replace function public.queue_notification(
  recipient uuid,
  kind text,
  context uuid,
  subject text,
  body text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  addr text;
begin
  if recipient is null then
    return;
  end if;

  addr := public.notify_email_for(recipient);
  -- No address means no notification. Better a missing email than a row that
  -- fails forever in the outbox.
  if addr is null or addr = '' then
    return;
  end if;

  if exists (
    select 1 from public.notifications n
    where n.recipient_profile_id = recipient
      and n.kind = queue_notification.kind
      and n.context_id is not distinct from context
      and n.sent_at is null
  ) then
    return;
  end if;

  insert into public.notifications
    (recipient_profile_id, kind, context_id, email, subject, body)
  values
    (recipient, queue_notification.kind, context, addr,
     queue_notification.subject, queue_notification.body);
end;
$$;

-- ---------------------------------------------------------------------------
-- The three moments that matter.
-- ---------------------------------------------------------------------------

/** Someone sent you a message. */
create or replace function public.on_message_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  other_id uuid;
  sender_name text;
begin
  select case when c.participant_a = new.sender_profile_id
              then c.participant_b else c.participant_a end
    into other_id
  from public.conversations c
  where c.id = new.conversation_id;

  -- Never email somebody about their own message.
  if other_id is null or other_id = new.sender_profile_id then
    return new;
  end if;

  select p.display_name into sender_name
  from public.profiles p where p.id = new.sender_profile_id;

  perform public.queue_notification(
    other_id,
    'message',
    new.conversation_id,
    format('%s messaged you on SideSpace', coalesce(sender_name, 'Someone')),
    format(
      E'%s sent you a message about your space:\n\n  "%s"\n\nReply here: https://sidespace-marketplace.vercel.app/',
      coalesce(sender_name, 'Someone'),
      left(new.body, 300)
    )
  );
  return new;
end;
$$;

drop trigger if exists messages_notify on public.messages;
create trigger messages_notify
  after insert on public.messages
  for each row execute function public.on_message_notify();

/** Someone wants to book your listing. */
create or replace function public.on_request_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requester_name text;
  listing_title text;
begin
  if new.owner_profile_id is null
     or new.owner_profile_id = new.requester_profile_id then
    return new;
  end if;

  select p.display_name into requester_name
  from public.profiles p where p.id = new.requester_profile_id;
  select l.title into listing_title
  from public.listings l where l.id = new.listing_id;

  perform public.queue_notification(
    new.owner_profile_id,
    'request',
    new.id,
    format('%s wants to book %s',
           coalesce(requester_name, 'Someone'),
           coalesce(listing_title, 'your listing')),
    format(
      E'%s has requested "%s".\n\nNothing is agreed until you accept, and you can counter with a different number.\n\nOpen it here: https://sidespace-marketplace.vercel.app/',
      coalesce(requester_name, 'Someone'),
      coalesce(listing_title, 'your listing')
    )
  );
  return new;
end;
$$;

drop trigger if exists campaign_requests_notify on public.campaign_requests;
create trigger campaign_requests_notify
  after insert on public.campaign_requests
  for each row execute function public.on_request_notify();

/** Your request was answered. The requester has been waiting on this one. */
create or replace function public.on_request_answered_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_name text;
  listing_title text;
  headline text;
begin
  if new.status = old.status
     or new.status not in ('accepted', 'declined', 'countered') then
    return new;
  end if;

  select p.display_name into owner_name
  from public.profiles p where p.id = new.owner_profile_id;
  select l.title into listing_title
  from public.listings l where l.id = new.listing_id;

  headline := case new.status
    when 'accepted'  then format('%s accepted your request', coalesce(owner_name, 'The owner'))
    when 'declined'  then format('%s declined your request', coalesce(owner_name, 'The owner'))
    else                  format('%s countered your offer',  coalesce(owner_name, 'The owner'))
  end;

  perform public.queue_notification(
    new.requester_profile_id,
    'request_' || new.status,
    new.id,
    headline,
    format(
      E'%s — on "%s".\n\nOpen it here: https://sidespace-marketplace.vercel.app/',
      headline,
      coalesce(listing_title, 'your listing')
    )
  );
  return new;
end;
$$;

drop trigger if exists campaign_requests_answered_notify on public.campaign_requests;
create trigger campaign_requests_answered_notify
  after update of status on public.campaign_requests
  for each row execute function public.on_request_answered_notify();
