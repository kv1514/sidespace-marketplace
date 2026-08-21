-- Trigger functions do not need EXECUTE granted to anybody: the trigger fires
-- as part of the table operation, not as a call from the client. Left as they
-- were created in 0011, PostgREST served both at /rest/v1/rpc/..., callable by
-- anon, which Supabase's own linter flags.
--
-- Neither is exploitable on its own (both dereference `new`, which is only
-- bound inside a trigger, so a direct call raises), but an exposed
-- SECURITY DEFINER endpoint is the same class of mistake as the
-- blocked_between leak fixed in 0009 and should not be left standing.
--
-- Verified after applying, in a transaction that was rolled back: switching a
-- role to consumer still pauses that member's live listings, and the 25
-- listing cap still raises listing_cap_reached. Revoking EXECUTE does not stop
-- a trigger firing, because the trigger runs as part of the statement rather
-- than as a call the client is authorised to make.
--
-- Idempotent, so re-applying is a no-op.

revoke all on function public.enforce_listing_cap() from public, anon, authenticated;
revoke all on function public.pause_listings_when_role_becomes_consumer() from public, anon, authenticated;
