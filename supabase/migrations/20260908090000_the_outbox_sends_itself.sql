-- The outbox sends itself.
--
-- Until now the notification outbox drained only while a Claude session was
-- awake with a live Supabase connector. On 2026-09-07 that connector dropped
-- for ten hours and nothing sent. Nothing was queued in those ten hours, so it
-- cost nothing - but it is the same shape as the failure the outbox exists to
-- prevent, where Troy VEX Robotics messaged Tharun Manigandan and Tharun was
-- never told. A mailer whose liveness depends on a chat window being open is
-- not a mailer.
--
-- pg_cron wakes every minute and asks pg_net to poke an edge function, which
-- claims a batch, sends it through Resend, and writes back what happened.
--
-- WHAT MAKES DOUBLE-SENDING IMPOSSIBLE. Claiming is a single statement:
-- `for update skip locked` picks rows no other run holds, and the same
-- statement stamps claimed_at before anyone else can read them. Two overlapping
-- runs therefore claim disjoint sets. A run that dies mid-flight leaves rows
-- stamped but unsent; those become claimable again after five minutes, which is
-- long enough that a slow send is not raced and short enough that a crash is
-- not a lost evening. Every claim spends an attempt, so a row that repeatedly
-- kills its worker still dead-letters at three rather than looping forever.
--
-- Secrets live in Vault, not here, so this migration is the same in every
-- environment: outbox_function_url and outbox_shared_secret. Until both exist
-- the drain is a no-op that logs a notice, so scheduling it before the secrets
-- are set is harmless rather than a failing job every minute.

-- pg_cron is not relocatable: it takes pg_catalog and brings the cron schema
-- with it. pg_net registers under extensions but puts http_post in net.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

alter table public.notifications
  add column if not exists claimed_at timestamptz;

comment on column public.notifications.claimed_at is
  'When a drain run took this row. Set by private.claim_notification_batch and '
  'cleared on success or failure. A stamp older than the reclaim window means '
  'the run that took it died, and the row is free again.';

-- The queue is read by "oldest unsent first", so index exactly that.
create index if not exists notifications_unsent_idx
  on public.notifications (created_at)
  where sent_at is null;

create or replace function private.claim_notification_batch(
  p_limit integer default 25,
  p_max_attempts integer default 3,
  p_reclaim_after interval default interval '5 minutes'
)
returns table (
  id uuid,
  email text,
  subject text,
  body text,
  kind text
)
language sql
security definer
set search_path = ''
as $$
  update public.notifications
  set claimed_at = now(),
      attempts = attempts + 1
  where public.notifications.id in (
    select candidate.id
    from public.notifications candidate
    where candidate.sent_at is null
      and candidate.attempts < p_max_attempts
      and (
        candidate.claimed_at is null
        or candidate.claimed_at < now() - p_reclaim_after
      )
    order by candidate.created_at
    limit p_limit
    for update skip locked
  )
  returning
    public.notifications.id,
    public.notifications.email,
    public.notifications.subject,
    public.notifications.body,
    public.notifications.kind;
$$;

create or replace function private.mark_notification_sent(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.notifications
  set sent_at = now(),
      claimed_at = null,
      error = null
  where id = p_id
    and sent_at is null;
$$;

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
  set claimed_at = null,
      error = left(coalesce(p_error, 'unknown error'), 500)
  where id = p_id
    and sent_at is null;
$$;

revoke all on function private.claim_notification_batch(integer, integer, interval)
  from public, anon, authenticated, service_role;
revoke all on function private.mark_notification_sent(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.mark_notification_failed(uuid, text)
  from public, anon, authenticated, service_role;

-- The edge function reaches these through PostgREST as the service role.
grant execute on function private.claim_notification_batch(integer, integer, interval)
  to service_role;
grant execute on function private.mark_notification_sent(uuid) to service_role;
grant execute on function private.mark_notification_failed(uuid, text) to service_role;

-- PostgREST only serves the schemas it is configured to expose, and private is
-- deliberately not one of them - that is why the helpers live there. So the
-- sender reaches them through three wrappers in public that do nothing but
-- delegate. They are revoked from everyone and granted to service_role alone,
-- which is server-side only, so putting them in public widens nothing: an anon
-- or signed-in caller gets a permission error, not a queue.

create or replace function public.claim_notification_batch(p_limit integer default 25)
returns table (id uuid, email text, subject text, body text, kind text)
language sql
security definer
set search_path = ''
as $$
  select * from private.claim_notification_batch(p_limit);
$$;

create or replace function public.mark_notification_sent(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.mark_notification_sent(p_id);
$$;

create or replace function public.mark_notification_failed(p_id uuid, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.mark_notification_failed(p_id, p_error);
$$;

revoke all on function public.claim_notification_batch(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_notification_sent(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_notification_failed(uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.claim_notification_batch(integer) to service_role;
grant execute on function public.mark_notification_sent(uuid) to service_role;
grant execute on function public.mark_notification_failed(uuid, text) to service_role;

create or replace function private.drain_notification_outbox()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  function_url text;
  shared_secret text;
  pending integer;
begin
  select decrypted_secret into function_url
  from vault.decrypted_secrets where name = 'outbox_function_url';
  select decrypted_secret into shared_secret
  from vault.decrypted_secrets where name = 'outbox_shared_secret';

  if function_url is null or shared_secret is null then
    raise notice
      'Outbox drain skipped: set the outbox_function_url and outbox_shared_secret vault secrets.';
    return;
  end if;

  -- Waking the sender costs an HTTP request, so do not make it for an empty
  -- queue. Every minute of an idle marketplace is an empty queue.
  select count(*) into pending
  from public.notifications
  where sent_at is null
    and attempts < 3
    and (claimed_at is null or claimed_at < now() - interval '5 minutes');

  if pending = 0 then
    return;
  end if;

  perform net.http_post(
    url := function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-outbox-secret', shared_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

revoke all on function private.drain_notification_outbox()
  from public, anon, authenticated, service_role;

select cron.unschedule('drain-notification-outbox')
where exists (
  select 1 from cron.job where jobname = 'drain-notification-outbox'
);

select cron.schedule(
  'drain-notification-outbox',
  '* * * * *',
  $cron$select private.drain_notification_outbox()$cron$
);
