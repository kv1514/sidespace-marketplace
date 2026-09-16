-- A failed send must not spend the row's whole attempt budget in three minutes.
--
-- pg_cron wakes the drain every minute and every claim spends an attempt, so
-- if a failure frees the row immediately, a provider blip retires a
-- notification that was never delivered. These assertions pin the spacing:
-- a failed row keeps its claim stamp, is untouchable until the reclaim window
-- has passed, and only then spends attempt two.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- The helpers are private and granted to service_role alone; nobody reachable
-- from a browser may claim or retire a notification.
select ok(
  not has_function_privilege('anon',
    'private.mark_notification_failed(uuid, text)', 'execute'),
  'anonymous clients cannot retire a notification'
);
select ok(
  not has_function_privilege('authenticated',
    'private.mark_notification_failed(uuid, text)', 'execute'),
  'signed-in members cannot retire a notification'
);
select ok(
  has_function_privilege('service_role',
    'private.mark_notification_failed(uuid, text)', 'execute'),
  'the sender, as service_role, may retire a notification'
);

insert into public.notifications (id, email, subject, body, kind)
values (
  'a1000000-0000-0000-0000-00000000f001',
  'waits-its-turn@example.invalid',
  'Someone messaged you on SideSpace',
  'A message about your space.',
  'message'
);

-- Minute one: the drain claims it and the send fails.
select is(
  (select count(*)::integer
     from private.claim_notification_batch(25, 3, interval '5 minutes')),
  1,
  'the first drain run claims the queued notification'
);
select private.mark_notification_failed(
  'a1000000-0000-0000-0000-00000000f001', 'Resend 500');

select is(
  (select attempts from public.notifications
    where id = 'a1000000-0000-0000-0000-00000000f001'),
  1,
  'a failed send has spent exactly one attempt'
);
select ok(
  (select claimed_at is not null from public.notifications
    where id = 'a1000000-0000-0000-0000-00000000f001'),
  'a failed send keeps its claim stamp, so the reclaim window applies'
);

-- The next three cron minutes fall inside the window and must take nothing.
select is(
  (select count(*)::integer
     from private.claim_notification_batch(25, 3, interval '5 minutes')),
  0,
  'the very next cron minute does not re-claim a just-failed row'
);
select is(
  (select count(*)::integer
     from private.claim_notification_batch(25, 3, interval '5 minutes')),
  0,
  'nor does the minute after that'
);
select is(
  (select attempts from public.notifications
    where id = 'a1000000-0000-0000-0000-00000000f001'),
  1,
  'cron minutes inside the window spend no attempts'
);

-- Once the window has passed the row is tried again, not abandoned. now() is
-- frozen for the whole transaction, so the stamp is moved back rather than
-- waiting out five real minutes - the claim filter compares the two, and this
-- puts them the same distance apart that elapsed time would.
update public.notifications
set claimed_at = now() - interval '6 minutes'
where id = 'a1000000-0000-0000-0000-00000000f001';

select is(
  (select count(*)::integer
     from private.claim_notification_batch(25, 3, interval '5 minutes')),
  1,
  'once the reclaim window has passed the row is claimed again'
);
select is(
  (select attempts from public.notifications
    where id = 'a1000000-0000-0000-0000-00000000f001'),
  2,
  'the retry spends attempt two'
);

-- Success still clears the stamp and the error, and retires the row for good.
select private.mark_notification_sent('a1000000-0000-0000-0000-00000000f001');
select ok(
  (select sent_at is not null and claimed_at is null and error is null
     from public.notifications
    where id = 'a1000000-0000-0000-0000-00000000f001'),
  'a sent notification is stamped sent, unclaimed and free of error'
);
update public.notifications
set claimed_at = now() - interval '6 minutes'
where id = 'a1000000-0000-0000-0000-00000000f001';

select is(
  (select count(*)::integer
     from private.claim_notification_batch(25, 3, interval '5 minutes')),
  0,
  'a sent notification is never claimed again, however old its stamp'
);

select * from extensions.finish();
rollback;
