-- Explicit timing and price bases. NULL preserves the original listing contract.
alter table public.listings
  add column timing_kind text check (timing_kind in ('deadline','date_range')),
  add column pricing_kind text check (pricing_kind in ('fixed','day','week','30_days')),
  add column minimum_duration_days integer not null default 1 check (minimum_duration_days between 1 and 365),
  add constraint listings_timing_pricing check (
    (timing_kind is null and pricing_kind is null) or
    (timing_kind is not null and pricing_kind is not null and
      (timing_kind <> 'deadline' or (pricing_kind = 'fixed' and minimum_duration_days = 1 and booking_duration_days = 1)))
  );
alter table public.campaign_requests
  add column timing_kind text check (timing_kind in ('deadline','date_range')),
  add column pricing_kind text check (pricing_kind in ('fixed','day','week','30_days')),
  add column listing_terms jsonb not null default '{}'::jsonb,
  add constraint campaign_deadline_single_date check (timing_kind is distinct from 'deadline' or start_date = end_date);
alter table public.campaign_requests drop constraint campaign_requests_goals_check;
alter table public.campaign_requests alter column goals set default '';
alter table public.campaign_requests add constraint campaign_requests_goals_check check (char_length(goals) <= 1500);
grant select (timing_kind,pricing_kind,minimum_duration_days) on public.listings to anon,authenticated;

-- Private contact writes must use the owner helper: auth_user_id is not a
-- browser-readable profile column. Keep every contact row owner-only.
alter policy "Members read their own contact details" on public.profile_contacts
  using (private.profile_owned_by_current_user(profile_id));
alter policy "Members write their own contact details" on public.profile_contacts
  with check (private.profile_owned_by_current_user(profile_id));
alter policy "Members update their own contact details" on public.profile_contacts
  using (private.profile_owned_by_current_user(profile_id))
  with check (private.profile_owned_by_current_user(profile_id));

-- Retain the existing owner-only helper; do not grant access to private columns.
create or replace view public.my_listings with (security_invoker=true,security_barrier=true) as
select id,owner_profile_id,title,channel,format,price_cents,price_unit,description,demographics,image_url,status,created_at,updated_at,
 image_urls,location_area,availability_notes,available_from,available_to,lead_time_days,minimum_booking,deliverables,cancellation_policy,
 price_max_cents,brief_scope,target_platforms,street_address,surface_types,install_by,space_size,sponsor_tier,sponsor_slots,
 provenance_status,availability_confirmed_at,instant_booking_enabled,availability_dates,booking_duration_days,booking_timezone,street_view_captured,
 timing_kind,pricing_kind,minimum_duration_days from private.current_user_listing_rows();

create function private.listing_subtotal_cents(rate bigint, day_count integer, basis text) returns bigint
language sql immutable strict set search_path='' as $$
 select round(rate::numeric * case when basis='fixed' then 1 else day_count end /
   case basis when 'week' then 7 when '30_days' then 30 else 1 end)::bigint
$$;
revoke all on function private.listing_subtotal_cents(bigint,integer,text) from public;
grant execute on function private.listing_subtotal_cents(bigint,integer,text) to authenticated,service_role;

-- Shared authoritative read, also used under the reservation's listing lock.
create function public.quote_listing_booking(target_listing_id uuid, booking_date date, booking_end_date date, expected_updated_at timestamptz)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare l public.listings; last_day date; local_today date; days integer; subtotal bigint;
begin
 select * into l from public.listings where id=target_listing_id;
 if l.id is null or l.status <> 'active' or l.channel='Business brief' or l.provenance_status not in ('owner_attested','staff_verified')
   or l.availability_confirmed_at is null or l.availability_confirmed_at < now()-interval '90 days'
   or not exists(select 1 from public.profiles where id=l.owner_profile_id and onboarding_complete and not is_demo and not is_internal)
 then raise exception 'This listing is not available for booking.'; end if;
 if expected_updated_at is null or l.updated_at<>expected_updated_at then raise exception 'This listing changed. Refresh it to review the latest terms.'; end if;
 if l.price_max_cents>l.price_cents then raise exception 'Send a custom offer for this price range.'; end if;
 local_today := (now() at time zone l.booking_timezone)::date;
 last_day := case when l.timing_kind='deadline' then booking_date else coalesce(booking_end_date,booking_date+l.booking_duration_days-1) end;
 if booking_date is null or last_day is null or last_day<booking_date or booking_date<local_today+l.lead_time_days or last_day>local_today+365 then
   raise exception 'Choose available dates within the next year and allow the required notice.'; end if;
 days := last_day-booking_date+1;
 if l.timing_kind='deadline' and booking_end_date is not null and booking_end_date<>booking_date then raise exception 'Choose one delivery deadline.'; end if;
 if (l.timing_kind is not null or l.instant_booking_enabled) and coalesce(l.pricing_kind,'fixed')='fixed' and days<>l.booking_duration_days then
   raise exception 'This package includes % days.',l.booking_duration_days; end if;
 if days<l.minimum_duration_days then raise exception 'Choose at least % days.',l.minimum_duration_days; end if;
 if (l.available_from is not null and booking_date<l.available_from) or (l.available_to is not null and last_day>l.available_to) then
   raise exception 'Choose dates within the listing availability.'; end if;
 if l.instant_booking_enabled and exists(select 1 from generate_series(0,days-1) n where not ((booking_date+n)=any(l.availability_dates))) then
   raise exception 'This package is not available on those dates.'; end if;
 if exists(select 1 from public.campaign_requests c left join private.listing_booking_reservations r on r.campaign_request_id=c.id
   where c.listing_id=l.id and c.status in ('accepted','confirmed','completed','disputed')
   and c.start_date<=last_day and c.end_date>=booking_date
   and (not c.instant_booking or (r.released_at is null and (r.checkout_started or r.held_until>now())))) then
   raise exception 'These dates were just booked. Choose another date.'; end if;
 subtotal := private.listing_subtotal_cents(l.price_cents,days,coalesce(l.pricing_kind,'fixed'));
 if subtotal<=0 or subtotal>9007199254740991 then raise exception 'Choose a valid price and duration.'; end if;
 return jsonb_build_object('timingKind',coalesce(l.timing_kind,'date_range'),'pricingKind',l.pricing_kind,
   'rateCents',l.price_cents,'priceUnit',coalesce(l.pricing_kind,l.price_unit),'startDate',booking_date,'endDate',last_day,'days',days,'subtotalCents',subtotal,'listingUpdatedAt',l.updated_at);
end $$;
revoke all on function public.quote_listing_booking(uuid,date,date,timestamptz) from public,anon,authenticated;
grant execute on function public.quote_listing_booking(uuid,date,date,timestamptz) to service_role;

-- Snapshot terms on insertion, including seller-approved bookings. RLS still
-- verifies the caller and participants; the trigger never grants access.
create function private.snapshot_campaign_timing() returns trigger
language plpgsql security definer set search_path='' as $$
declare l public.listings; q jsonb;
begin
 if tg_op='UPDATE' then
   if new.timing_kind is distinct from old.timing_kind or new.pricing_kind is distinct from old.pricing_kind or new.listing_terms is distinct from old.listing_terms then
     raise exception 'Booking timing and price terms are immutable.'; end if;
   return new;
 end if;
 select * into l from public.listings where id=new.listing_id;
 if new.purchase_mode='buy_now' then
   -- Reservation validates under its lock, before inserting its accepted row.
   if not new.instant_booking then
     if l.timing_kind is not null and (new.listing_terms->>'listing_updated_at')::timestamptz is distinct from l.updated_at then raise exception 'This listing changed. Review the latest terms.'; end if;
     q := public.quote_listing_booking(l.id,new.start_date,new.end_date,l.updated_at);
     if new.budget_cents<>(q->>'subtotalCents')::bigint then raise exception 'The price changed. Review your booking again.'; end if;
   end if;
   new.timing_kind := l.timing_kind;
   new.pricing_kind := l.pricing_kind;
 else
   new.timing_kind := coalesce(new.timing_kind,l.timing_kind);
   new.pricing_kind := null;
 end if;
 new.listing_terms := jsonb_build_object('listing_updated_at',l.updated_at,'rate_cents',l.price_cents,'price_unit',l.price_unit,
   'pricing_kind',new.pricing_kind,'timing_kind',new.timing_kind,'cancellation_policy',l.cancellation_policy,'booking_timezone',l.booking_timezone,
   'minimum_duration_days',l.minimum_duration_days,'booking_duration_days',l.booking_duration_days,'lead_time_days',l.lead_time_days);
 return new;
end $$;
revoke all on function private.snapshot_campaign_timing() from public,anon,authenticated;
create trigger snapshot_campaign_timing before insert or update on public.campaign_requests for each row execute function private.snapshot_campaign_timing();
create function public.reserve_listing_booking(
  target_listing_id uuid, buyer_profile_id uuid, booking_date date,
  expected_updated_at timestamptz, payment_livemode boolean, booking_end_date date
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare listing public.listings; buyer public.profiles; last_day date; local_today date;
  existing_id uuid; campaign_id uuid; day_count integer; q jsonb; subtotal bigint;
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
  last_day := case when listing.timing_kind='deadline' then booking_date else coalesce(booking_end_date, booking_date+listing.booking_duration_days-1) end;
  if listing.timing_kind='deadline' and booking_end_date is not null and booking_end_date<>booking_date then raise exception 'Choose one delivery deadline.'; end if;
  perform private.expire_unstarted_listing_bookings(target_listing_id);
  select c.id into existing_id from public.campaign_requests c
    join private.listing_booking_reservations r on r.campaign_request_id = c.id
    where c.listing_id = target_listing_id and c.requester_profile_id = buyer_profile_id
      and c.start_date = booking_date and c.end_date = last_day and c.status = 'accepted' and r.released_at is null;
  if existing_id is not null then
    if not exists (select 1 from private.listing_booking_reservations r where r.campaign_request_id = existing_id
      and (r.terms->>'listing_updated_at')::timestamptz = listing.updated_at) then
      raise exception 'You already have a checkout for earlier terms. Continue it from Dashboard or wait for it to expire.';
    end if;
    return existing_id;
  end if;
  q := public.quote_listing_booking(listing.id,booking_date,booking_end_date,expected_updated_at);
  last_day := (q->>'endDate')::date;
  subtotal := (q->>'subtotalCents')::bigint;
  insert into public.campaign_requests (
    listing_id, requester_profile_id, owner_profile_id, campaign_name, goals,
    requested_deliverables, budget_cents, start_date, end_date, status,
    accepted_subtotal_cents, payer_profile_id, payee_profile_id, instant_booking, purchase_mode, notes
  ) values (
    listing.id, buyer.id, listing.owner_profile_id, left(listing.title, 120),
    'Deliver the advertising package as listed.', listing.deliverables,
    subtotal, booking_date, last_day, 'accepted', subtotal,
    buyer.id, listing.owner_profile_id, true, 'buy_now',
    'Instant booking. Cancellation terms: ' || listing.cancellation_policy
  ) returning id into campaign_id;
  insert into private.listing_booking_reservations(campaign_request_id, listing_id, start_date, end_date, terms)
    values(campaign_id, listing.id, booking_date, last_day, jsonb_build_object(
      'title', listing.title, 'price_cents', listing.price_cents, 'price_unit', listing.price_unit,
      'deliverables', listing.deliverables, 'cancellation_policy', listing.cancellation_policy,
      'timing_kind',listing.timing_kind,'pricing_kind',listing.pricing_kind,'subtotal_cents',subtotal,'booking_timezone', listing.booking_timezone, 'listing_updated_at', listing.updated_at));
  return campaign_id;
end $$;


-- Retain old clients and fixtures. New clients provide the complete interval.
create or replace function public.reserve_listing_booking(target_listing_id uuid,buyer_profile_id uuid,booking_date date,expected_updated_at timestamptz,payment_livemode boolean)
returns uuid language sql security invoker set search_path='' as $$
 select public.reserve_listing_booking(target_listing_id,buyer_profile_id,booking_date,expected_updated_at,payment_livemode,null)
$$;
revoke all on function public.reserve_listing_booking(uuid,uuid,date,timestamptz,boolean,date) from public,anon,authenticated;
grant execute on function public.reserve_listing_booking(uuid,uuid,date,timestamptz,boolean,date) to service_role;
drop policy if exists "Members create campaign requests" on public.campaign_requests;
create policy "Members create campaign requests"
on public.campaign_requests for insert to authenticated
with check (
  status = 'pending'
  and counter_budget_cents is null
  and counter_message = ''
  and accepted_subtotal_cents is null
  and payer_profile_id is null
  and payee_profile_id is null
  and requester_profile_id <> owner_profile_id
  and not private.profile_is_internal(requester_profile_id)
  and not private.profile_is_internal(owner_profile_id)
  and not private.blocked_between(requester_profile_id, owner_profile_id)
  and private.profile_owned_by_current_user(requester_profile_id)
  and exists (
    select 1 from public.profiles profile
    where profile.id = campaign_requests.requester_profile_id
      and profile.onboarding_complete
  )
  and exists (
    select 1
    from public.listings listing
    where listing.id = campaign_requests.listing_id
      and listing.owner_profile_id = campaign_requests.owner_profile_id
      and listing.status = 'active'
      and listing.provenance_status in ('owner_attested', 'staff_verified')
      and listing.availability_confirmed_at >= now() - interval '90 days'
      and not private.profile_is_internal(listing.owner_profile_id)
      and (
        purchase_mode = 'offer'
        or (
          purchase_mode = 'buy_now'
          and listing.channel <> 'Business brief'
          and (
            listing.price_max_cents is null
            or listing.price_max_cents <= listing.price_cents
          )
          and campaign_requests.budget_cents = private.listing_subtotal_cents(listing.price_cents,campaign_requests.end_date-campaign_requests.start_date+1,coalesce(listing.pricing_kind,'fixed'))
          and campaign_requests.requested_deliverables =
            coalesce(nullif(trim(listing.deliverables), ''), trim(listing.format))
          and (
            listing.available_from is null
            or campaign_requests.start_date >= listing.available_from
          )
          and (
            listing.available_to is null
            or campaign_requests.end_date <= listing.available_to
          )
          and campaign_requests.start_date >= (now() at time zone listing.booking_timezone)::date + listing.lead_time_days
        )
      )
  )
);

create or replace function public.listing_available_dates(target_listing_id uuid) returns date[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(d order by d), '{}') from public.listings l,
    lateral unnest(l.availability_dates) d
  where l.id = target_listing_id and l.status = 'active' and l.instant_booking_enabled
    and l.provenance_status in ('owner_attested', 'staff_verified')
    and l.availability_confirmed_at >= now() - interval '90 days'
    and exists (select 1 from public.profiles p where p.id = l.owner_profile_id
      and p.onboarding_complete and not p.is_demo and not p.is_internal)
    and d >= (now() at time zone l.booking_timezone)::date + l.lead_time_days
    and d + (case when l.timing_kind='deadline' or l.pricing_kind in ('day','week','30_days') then 1 else l.booking_duration_days end) - 1 <= (now() at time zone l.booking_timezone)::date + 365
    and not exists (select 1 from generate_series(0, (case when l.timing_kind='deadline' or l.pricing_kind in ('day','week','30_days') then 1 else l.booking_duration_days end) - 1) n
      where not ((d + n) = any(l.availability_dates)))
    and not exists (select 1 from public.campaign_requests c
      left join private.listing_booking_reservations r on r.campaign_request_id = c.id
      where c.listing_id = l.id and c.status in ('accepted', 'confirmed', 'completed', 'disputed')
        and c.start_date <= d + (case when l.timing_kind='deadline' or l.pricing_kind in ('day','week','30_days') then 1 else l.booking_duration_days end) - 1 and c.end_date >= d
        and (not c.instant_booking or (r.released_at is null and (r.checkout_started or r.held_until > now()))))
$$;
-- One schedule label for queued notifications, matching the application.
create function private.booking_date_label(kind text, first_day date, last_day date) returns text
language sql immutable set search_path='' as $$
 select case when kind='deadline' then 'Deliver by ' || to_char(last_day,'FMMonth FMDD, YYYY')
 else (case when first_day=last_day then to_char(first_day,'FMMonth FMDD, YYYY')
   when to_char(first_day,'YYYY-MM')=to_char(last_day,'YYYY-MM') then to_char(first_day,'FMMonth FMDD') || '–' || to_char(last_day,'FMDD, YYYY')
   else to_char(first_day,'FMMonth FMDD, YYYY') || ' – ' || to_char(last_day,'FMMonth FMDD, YYYY') end)
   || ' · ' || (last_day-first_day+1) || case when first_day=last_day then ' day' else ' days' end end
$$;
revoke all on function private.booking_date_label(text,date,date) from public,anon,authenticated;

create or replace function private.notify_instant_booking_confirmed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.queue_notification(new.owner_profile_id, 'request_accepted', new.id,
    'Paid booking: ' || new.campaign_name,
    format(E'A business has paid for your listed package: %s. No acceptance is needed.\n\nReview the booking and coordinate creative materials in your Dashboard: https://sidespace.ad/dashboard', private.booking_date_label(new.timing_kind,new.start_date,new.end_date)));
  perform public.queue_notification(new.requester_profile_id, 'request_accepted', new.id,
    'Your booking is confirmed: ' || new.campaign_name,
    format(E'Your payment is confirmed: %s. Your listed package is booked.\n\nView your booking and coordinate creative materials in your Dashboard: https://sidespace.ad/dashboard', private.booking_date_label(new.timing_kind,new.start_date,new.end_date)));
  return new;
end $$;

create or replace function private.guard_campaign_booking_dates() returns trigger
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
    if exists(select 1 from public.listings where id=new.listing_id and timing_kind is not null)
      and exists(select 1 from public.campaign_requests c
      left join private.listing_booking_reservations r on r.campaign_request_id=c.id
      where c.listing_id=new.listing_id and c.id<>new.id
      and c.status in ('accepted','confirmed','completed','disputed')
      and c.start_date<=new.end_date and c.end_date>=new.start_date
      and (not c.instant_booking or (r.released_at is null and (r.checkout_started or r.held_until>now())))) then
      raise exception 'These dates are already booked. Choose another date.';
    end if;
  end if;
  return new;
end $$;


create or replace function public.on_request_notify() returns trigger
language plpgsql security definer set search_path='' as $$
declare requester_name text; listing_title text; schedule text;
begin
 if new.owner_profile_id is null or new.owner_profile_id=new.requester_profile_id then return new; end if;
 select display_name into requester_name from public.profiles where id=new.requester_profile_id;
 select title into listing_title from public.listings where id=new.listing_id;
 schedule := private.booking_date_label(new.timing_kind,new.start_date,new.end_date);
 perform public.queue_notification(new.owner_profile_id,'request',new.id,
   format('%s wants to book %s',coalesce(requester_name,'Someone'),coalesce(listing_title,'your listing')),
   format(E'%s\n\n%s\n\nReview in your dashboard: https://sidespace.ad/dashboard',schedule,
     case when new.purchase_mode='buy_now' then 'Confirm or decline this booking request. Payment follows your confirmation.' else 'Review the offer, then accept, decline, or counter.' end));
 return new;
end $$;

notify pgrst, 'reload schema';
