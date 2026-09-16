-- A failed send waits its turn.
--
-- private.mark_notification_failed cleared claimed_at, which handed the row
-- straight back to the next cron run. Every claim spends an attempt and cron
-- wakes each minute, so a failure that had nothing to do with the row - Resend
-- briefly down, a key not yet set - burned attempts one, two and three on three
-- consecutive minutes. The row then fell out of `attempts < 3` and was retired
-- for good, having never been sent, three minutes after the first hiccup. The
-- outbox exists so that nobody is left uninformed the way Tharun Manigandan
-- was; retiring a notification that fast is that same failure in a new place.
--
-- Keeping the stamp puts a failed row back under the reclaim window, so the
-- next attempt comes five minutes later instead of sixty seconds later. Three
-- attempts then span fifteen minutes, which a brief provider outage survives.
-- Nothing else moves: the row is still claimable, still dead-letters at three,
-- and double-sending is still impossible, because claiming is the same single
-- `for update skip locked` statement it has always been. A row whose run died
-- mid-flight and a row whose send failed now look alike, and want the same
-- thing - to be tried again once the window has passed.

create or replace function private.mark_notification_failed(
  p_id uuid,
  p_error text
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.notifications
  set error = left(coalesce(p_error, 'unknown error'), 500)
  where id = p_id
    and sent_at is null;
$$;

revoke all on function private.mark_notification_failed(uuid, text)
  from public, anon, authenticated, service_role;

-- The edge function reaches this through its public wrapper as the service role.
grant execute on function private.mark_notification_failed(uuid, text) to service_role;

comment on column public.notifications.claimed_at is
  'When a drain run took this row. Set by private.claim_notification_batch and '
  'cleared on success. Kept on failure, so the reclaim window decides when the '
  'next attempt happens rather than the next cron minute. A stamp older than '
  'the window means the run that took it died, or its send failed, and the row '
  'is free again.';
