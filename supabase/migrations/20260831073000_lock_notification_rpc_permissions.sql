-- Notification addresses and outbox writes are trigger-only server behavior.
-- Keep the security-definer functions callable by their trigger owners and the
-- service role, but do not expose either function as a client RPC.
revoke execute on function public.notify_email_for(uuid)
  from public, anon, authenticated;
revoke execute on function public.queue_notification(uuid, text, uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.notify_email_for(uuid) to service_role;
grant execute on function public.queue_notification(uuid, text, uuid, text, text)
  to service_role;
