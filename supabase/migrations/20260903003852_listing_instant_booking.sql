-- Explicit seller consent, local-calendar dates, and server-owned reservations.
alter table public.listings
  add column instant_booking_enabled boolean not null default false,
  add column availability_dates date[] not null default '{}',
  add column booking_duration_days integer not null default 1 check (booking_duration_days between 1 and 365),
  add column booking_timezone text not null default 'UTC';
alter table public.campaign_requests add column instant_booking boolean not null default false;

grant select (instant_booking_enabled, availability_dates, booking_duration_days, booking_timezone)
  on public.listings to anon, authenticated;
create or replace view public.my_listings with (security_barrier = true) as
select listing.* from public.listings listing where exists (
  select 1 from public.profiles profile where profile.id = listing.owner_profile_id
    and profile.auth_user_id = (select auth.uid())
);

create table private.listing_booking_reservations (
  campaign_request_id uuid primary key references public.campaign_requests(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  held_until timestamptz not null default (now() + interval '30 minutes'),
  checkout_started boolean not null default false,
  checkout_expires_at timestamptz,
  released_at timestamptz,
  terms jsonb not null
);
create index listing_booking_reservations_active_idx on private.listing_booking_reservations(listing_id)
  where released_at is null;
alter table private.listing_booking_reservations enable row level security;
revoke all on private.listing_booking_reservations from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.blocked_between(uuid, uuid) to service_role;
grant all on private.listing_booking_reservations to service_role;

create function private.validate_listing_booking_schedule() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare local_today date;
begin
  if not exists (select 1 from pg_timezone_names where name = new.booking_timezone) then
    raise exception 'Choose a valid calendar time zone.';
  end if;
  local_today := (now() at time zone new.booking_timezone)::date;
  if cardinality(new.availability_dates) > 366 or exists (
    select 1 from unnest(new.availability_dates) d where d is null or d > local_today + 365
  ) then raise exception 'Choose available dates within the next year.'; end if;
  if new.instant_booking_enabled and (
    new.channel = 'Business brief' or new.price_cents <= 0
    or (new.price_max_cents is not null and new.price_max_cents <> new.price_cents)
    or char_length(trim(new.deliverables)) not between 2 and 1000
    or char_length(trim(new.cancellation_policy)) not between 2 and 1000
    or cardinality(new.availability_dates) = 0
  ) then raise exception 'Instant booking needs a fixed price, available dates, deliverables, and cancellation terms.'; end if;
  return new;
end $$;
create trigger validate_listing_booking_schedule before insert or update on public.listings
  for each row execute function private.validate_listing_booking_schedule();

-- Every acceptance locks the same listing as instant reservations. A custom
-- offer cannot accept dates held by checkout, and a checkout cannot sell dates
-- already committed by a custom offer. Pending requests do not block sales.
create function private.guard_campaign_booking_dates() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('role', true) in ('anon', 'authenticated') and
     (new.instant_booking or (tg_op = 'UPDATE' and old.instant_booking)) then
    raise exception 'Instant bookings are managed through secure checkout.';
  end if;
  if new.status in ('accepted', 'confirmed', 'completed', 'disputed') and
    (tg_op = 'INSERT' or old.status is distinct from new.status or old.start_date <> new.start_date or old.end_date <> new.end_date) then
    perform 1 from public.listings where id = new.listing_id for update;
    if exists (
      select 1 from private.listing_booking_reservations r
      where r.listing_id = new.listing_id and r.campaign_request_id <> new.id
        and r.released_at is null and (r.checkout_started or r.held_until > now())
        and r.start_date <= new.end_date and r.end_date >= new.start_date
    ) then raise exception 'These dates are already reserved. Choose another date.'; end if;
  end if;
  return new;
end $$;
create trigger guard_campaign_booking_dates before insert or update on public.campaign_requests
  for each row execute function private.guard_campaign_booking_dates();

-- Private cleanup only releases holds that never entered Stripe creation.
-- Started or uncertain checkouts remain held until provider-verified expiry.
create function private.expire_unstarted_listing_bookings(target_listing_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  with released as (
    update private.listing_booking_reservations set released_at = now()
    where listing_id = target_listing_id and released_at is null
      and not checkout_started and held_until <= now()
    returning campaign_request_id
  ) update public.campaign_requests set status = 'cancelled'
    where id in (select campaign_request_id from released) and status = 'accepted';
end $$;

create function public.reserve_listing_booking(
  target_listing_id uuid, buyer_profile_id uuid, booking_date date,
  expected_updated_at timestamptz, payment_livemode boolean
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare listing public.listings; buyer public.profiles; last_day date; local_today date;
  existing_id uuid; campaign_id uuid; day_count integer;
begin
  select * into listing from public.listings where id = target_listing_id for update;
  if listing.id is null or listing.status <> 'active' or not listing.instant_booking_enabled then
    raise exception 'This listing is not available for instant booking.'; end if;
  if expected_updated_at is null or listing.updated_at <> expected_updated_at then
    raise exception 'This listing changed. Refresh it to review the latest terms.'; end if;
  select * into buyer from public.profiles where id = buyer_profile_id;
  if buyer.id is null or buyer.is_demo or buyer.is_internal or not buyer.onboarding_complete
    or not ('business' = any(array_append(coalesce(buyer.extra_roles, '{}'), buyer.role)))
    or buyer.id = listing.owner_profile_id
    or private.blocked_between(buyer.id, listing.owner_profile_id) then
    raise exception 'Use an eligible Business profile to book this listing.'; end if;
  if not exists (select 1 from public.profiles p where p.id = listing.owner_profile_id
    and not p.is_demo and not p.is_internal and p.onboarding_complete
    and ('creator' = any(array_append(coalesce(p.extra_roles, '{}'), p.role))))
    or listing.provenance_status not in ('owner_attested', 'staff_verified')
    or listing.availability_confirmed_at is null
    or listing.availability_confirmed_at < now() - interval '90 days' then
    raise exception 'The owner needs to confirm this listing before it can be booked.'; end if;
  if not exists (select 1 from public.stripe_accounts a where a.profile_id = listing.owner_profile_id
    and a.livemode = payment_livemode and a.stripe_connected_account_id is not null
    and a.charges_enabled and a.payouts_enabled and a.details_submitted
    and cardinality(a.requirements_due) = 0) then
    raise exception 'The owner needs to finish payout setup before this listing can be booked.'; end if;
  local_today := (now() at time zone listing.booking_timezone)::date;
  last_day := booking_date + listing.booking_duration_days - 1;
  if booking_date is null or booking_date < local_today + listing.lead_time_days or last_day > local_today + 365 then
    raise exception 'Choose an available date within the next year and allow the required notice.'; end if;
  select count(*) into day_count from generate_series(0, listing.booking_duration_days - 1) n
    where (booking_date + n) = any(listing.availability_dates);
  if day_count <> listing.booking_duration_days then raise exception 'This package is not available on those dates.'; end if;
  perform private.expire_unstarted_listing_bookings(target_listing_id);
  select c.id into existing_id from public.campaign_requests c
    join private.listing_booking_reservations r on r.campaign_request_id = c.id
    where c.listing_id = target_listing_id and c.requester_profile_id = buyer_profile_id
      and c.start_date = booking_date and c.status = 'accepted' and r.released_at is null;
  if existing_id is not null then
    if not exists (select 1 from private.listing_booking_reservations r where r.campaign_request_id = existing_id
      and (r.terms->>'listing_updated_at')::timestamptz = listing.updated_at) then
      raise exception 'You already have a checkout for earlier terms. Continue it from Dashboard or wait for it to expire.';
    end if;
    return existing_id;
  end if;
  if exists (select 1 from public.campaign_requests c where c.listing_id = target_listing_id
    and c.status in ('accepted', 'confirmed', 'completed', 'disputed')
    and c.start_date <= last_day and c.end_date >= booking_date) then
    raise exception 'These dates were just booked. Choose another date.'; end if;
  insert into public.campaign_requests (
    listing_id, requester_profile_id, owner_profile_id, campaign_name, goals,
    requested_deliverables, budget_cents, start_date, end_date, status,
    accepted_subtotal_cents, payer_profile_id, payee_profile_id, instant_booking, purchase_mode, notes
  ) values (
    listing.id, buyer.id, listing.owner_profile_id, left(listing.title, 120),
    'Deliver the advertising package as listed.', listing.deliverables,
    listing.price_cents, booking_date, last_day, 'accepted', listing.price_cents,
    buyer.id, listing.owner_profile_id, true, 'buy_now',
    'Instant booking. Cancellation terms: ' || listing.cancellation_policy
  ) returning id into campaign_id;
  insert into private.listing_booking_reservations(campaign_request_id, listing_id, start_date, end_date, terms)
    values(campaign_id, listing.id, booking_date, last_day, jsonb_build_object(
      'title', listing.title, 'price_cents', listing.price_cents, 'price_unit', listing.price_unit,
      'deliverables', listing.deliverables, 'cancellation_policy', listing.cancellation_policy,
      'booking_timezone', listing.booking_timezone, 'listing_updated_at', listing.updated_at));
  return campaign_id;
end $$;

-- Called immediately before Stripe creation, also for campaign-ID retries.
create function public.begin_listing_booking_checkout(target_campaign_id uuid) returns timestamptz
language plpgsql security invoker set search_path = '' as $$
declare reservation private.listing_booking_reservations;
begin
  if not exists(select 1 from public.campaign_requests where id = target_campaign_id and instant_booking) then return null; end if;
  perform 1 from public.listings where id = (select listing_id from public.campaign_requests where id = target_campaign_id) for update;
  select * into reservation from private.listing_booking_reservations where campaign_request_id = target_campaign_id for update;
  if reservation.campaign_request_id is null or reservation.released_at is not null
    or (not reservation.checkout_started and reservation.held_until <= now()) then
    raise exception 'Your date hold expired. Reopen the listing to choose an available date.'; end if;
  update private.listing_booking_reservations set checkout_started = true,
    checkout_expires_at = coalesce(checkout_expires_at, date_trunc('second', now()) + interval '45 minutes')
    where campaign_request_id = target_campaign_id returning checkout_expires_at into reservation.checkout_expires_at;
  return reservation.checkout_expires_at;
end $$;

-- Existing webhook/reconciliation updates already verify Stripe's session.
create function private.sync_listing_booking_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'refunded' then
    update private.listing_booking_reservations set released_at = now()
      where campaign_request_id = new.campaign_request_id and released_at is null;
  end if;
  if new.status = 'expired' and old.status not in ('paid', 'partially_refunded', 'refunded', 'disputed') then
    update private.listing_booking_reservations set released_at = now()
      where campaign_request_id = new.campaign_request_id and released_at is null;
    if found then update public.campaign_requests set status = 'cancelled'
      where id = new.campaign_request_id and status = 'accepted'; end if;
  end if;
  return new;
end $$;
create trigger sync_listing_booking_payment after update of status on public.payment_transactions
  for each row execute function private.sync_listing_booking_payment();

-- Public response exposes only selectable dates, never buyers or reservations.
create function public.listing_available_dates(target_listing_id uuid) returns date[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(d order by d), '{}') from public.listings l,
    lateral unnest(l.availability_dates) d
  where l.id = target_listing_id and l.status = 'active' and l.instant_booking_enabled
    and l.provenance_status in ('owner_attested', 'staff_verified')
    and l.availability_confirmed_at >= now() - interval '90 days'
    and exists (select 1 from public.profiles p where p.id = l.owner_profile_id
      and p.onboarding_complete and not p.is_demo and not p.is_internal)
    and d >= (now() at time zone l.booking_timezone)::date + l.lead_time_days
    and d + l.booking_duration_days - 1 <= (now() at time zone l.booking_timezone)::date + 365
    and not exists (select 1 from generate_series(0, l.booking_duration_days - 1) n
      where not ((d + n) = any(l.availability_dates)))
    and not exists (select 1 from public.campaign_requests c
      left join private.listing_booking_reservations r on r.campaign_request_id = c.id
      where c.listing_id = l.id and c.status in ('accepted', 'confirmed', 'completed', 'disputed')
        and c.start_date <= d + l.booking_duration_days - 1 and c.end_date >= d
        and (not c.instant_booking or (r.released_at is null and (r.checkout_started or r.held_until > now()))))
$$;
revoke all on function public.reserve_listing_booking(uuid,uuid,date,timestamptz,boolean), public.begin_listing_booking_checkout(uuid) from public, anon, authenticated;
grant execute on function public.reserve_listing_booking(uuid,uuid,date,timestamptz,boolean), public.begin_listing_booking_checkout(uuid) to service_role;
revoke all on function public.listing_available_dates(uuid) from public;
grant execute on function public.listing_available_dates(uuid) to anon, authenticated, service_role;
revoke all on function private.validate_listing_booking_schedule(), private.guard_campaign_booking_dates(), private.expire_unstarted_listing_bookings(uuid), private.sync_listing_booking_payment() from public, anon, authenticated;
grant execute on function private.expire_unstarted_listing_bookings(uuid) to service_role;

-- Instant bookings do not send the legacy "please accept this request" email.
-- Notify both parties only after the existing payment webhook confirms payment.
drop trigger campaign_requests_notify on public.campaign_requests;
create trigger campaign_requests_notify after insert on public.campaign_requests
  for each row when (not new.instant_booking) execute function public.on_request_notify();
create function private.notify_instant_booking_confirmed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.queue_notification(new.owner_profile_id, 'request_accepted', new.id,
    'Paid booking: ' || new.campaign_name,
    format(E'A business has paid for your listed package on %s through %s. No acceptance is needed.\n\nReview the booking and coordinate creative materials in your Dashboard: https://sidespace.ad/dashboard', new.start_date, new.end_date));
  perform public.queue_notification(new.requester_profile_id, 'request_accepted', new.id,
    'Your booking is confirmed: ' || new.campaign_name,
    format(E'Your payment is confirmed for %s through %s. Your listed package is booked.\n\nView your booking and coordinate creative materials in your Dashboard: https://sidespace.ad/dashboard', new.start_date, new.end_date));
  return new;
end $$;
revoke all on function private.notify_instant_booking_confirmed() from public, anon, authenticated;
create trigger instant_booking_confirmed_notify after update of status on public.campaign_requests
  for each row when (new.instant_booking and new.status = 'confirmed' and old.status is distinct from new.status)
  execute function private.notify_instant_booking_confirmed();
