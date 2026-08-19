-- Nothing bounded how many listings one account could publish, and nothing
-- bounded how long a title could be. A single member could therefore bury the
-- marketplace grid, and a multi-kilobyte title would stretch every card that
-- rendered it. Both are cheap to abuse from the browser console with a session
-- that has already passed onboarding, so the limits belong in the database
-- rather than only in the form.
--
-- 25 is far above real use: the busiest account on the site has 2.
--
-- Already applied to production. Idempotent, so re-applying is a no-op.

create or replace function public.enforce_listing_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    select count(*) from public.listings
    where owner_profile_id = new.owner_profile_id
  ) >= 25 then
    raise exception 'listing_cap_reached';
  end if;
  return new;
end;
$$;

drop trigger if exists listings_cap_per_member on public.listings;
create trigger listings_cap_per_member
  before insert on public.listings
  for each row execute function public.enforce_listing_cap();

alter table public.listings drop constraint if exists listings_title_length;
alter table public.listings
  add constraint listings_title_length
  check (char_length(title) between 1 and 120);
