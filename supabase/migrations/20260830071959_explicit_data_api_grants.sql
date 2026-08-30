-- Supabase stopped automatically exposing newly-created public tables to the
-- Data API in 2026. Keep privileges explicit and let RLS remain the row-level
-- authorization boundary.

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.listings to authenticated;
grant select, insert on public.conversations to authenticated;
grant select, insert, update on public.messages to authenticated;
grant select, insert, update on public.campaign_requests to authenticated;
grant select, insert on public.verification_requests to authenticated;
grant select, insert on public.profile_reports to authenticated;
grant select, insert, delete on public.profile_blocks to authenticated;

-- Server routes and webhook handlers use service_role. Browser bundles never
-- receive this credential, and RLS stays enabled as defence in depth.
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

alter default privileges in schema public
  grant all privileges on tables to service_role;
alter default privileges in schema public
  grant all privileges on sequences to service_role;
