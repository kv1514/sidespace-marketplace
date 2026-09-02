-- Members can delete their own listings from the account panel.
--
-- The DELETE policy on listings has allowed this for a while, but nothing in
-- the product called it, and a bare delete is the wrong tool: open requests
-- would vanish through the cascade without a word to the business that sent
-- them, and a listing with payment history would fail on the RESTRICT from
-- payment_transactions with a foreign-key error nobody can read.
--
-- This function does it in order, in one transaction: refuse when money has
-- moved, decline every open request first so the existing request-answered
-- trigger queues the "declined" email while the listing title still exists,
-- then remove the listing. Returns how many requests were declined so the
-- form can say so.
create or replace function public.delete_own_listing(target_listing_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  own_profile_id uuid;
  target public.listings;
  declined integer := 0;
begin
  select id into own_profile_id
  from public.profiles
  where auth_user_id = (select auth.uid())
  limit 1;

  if own_profile_id is null then
    raise exception 'You need a profile to delete a listing.';
  end if;

  select * into target
  from public.listings
  where id = target_listing_id
    and owner_profile_id = own_profile_id
  for update;

  if target.id is null then
    raise exception 'That listing is not yours or was already removed.';
  end if;

  -- payment_transactions.listing_id is RESTRICT, so the delete below would
  -- fail anyway. Say why in words, and point at the tool that does work.
  if exists (
    select 1
    from public.payment_transactions transaction
    where transaction.listing_id = target.id
  ) then
    raise exception 'This listing has payment history, so it cannot be deleted. Pause it instead and it disappears from the marketplace.';
  end if;

  -- Decline before deleting: the answered-notify trigger reads the listing
  -- title, and the cascade would otherwise drop these rows silently.
  update public.campaign_requests
  set status = 'declined'
  where listing_id = target.id
    and status in ('pending', 'countered', 'accepted');
  get diagnostics declined = row_count;

  delete from public.listings where id = target.id;

  return declined;
end;
$$;

revoke execute on function public.delete_own_listing(uuid) from public, anon;
grant execute on function public.delete_own_listing(uuid) to authenticated;
