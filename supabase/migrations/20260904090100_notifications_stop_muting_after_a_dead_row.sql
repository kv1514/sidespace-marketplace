-- Stop one undeliverable notification from silencing a conversation forever.
--
-- `queue_notification` skips a new row while an unsent one already exists for
-- the same recipient, kind and context. That is deliberate: someone firing off
-- four messages in a row should not put four emails in somebody's inbox, and
-- once the first has been sent, the next message queues a fresh one.
--
-- The drain, though, only ever picks up `sent_at is null and attempts < 3`. So
-- a row that failed three times - one bad address, or three SMTP refusals in a
-- row - is never sent AND never superseded, because it is still sitting there
-- unsent. From that moment every further message, request and answer on that
-- thread is dropped in silence.
--
-- That is the failure this outbox was built to end, coming back in through the
-- retry counter: SideSpace had 16 members, 15 listings, 3 messages and zero
-- bookings because nothing ever told anyone they had been contacted.
--
-- A row the drain has given up on no longer holds the door shut. Coalescing is
-- unchanged for live rows, so a burst still produces one email; a dead row
-- simply stops counting as one, and stays in the table with its error for
-- whoever is looking.
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
      -- Must match the drain's own ceiling. A row it will never pick up again
      -- is not a pending notification, and must not stand in for one.
      and n.attempts < 3
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
