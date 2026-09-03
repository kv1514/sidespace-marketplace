-- Give buyers two clear paths through a supply listing:
--   * offer: propose a budget, scope, and timing for the owner to review
--   * buy_now: accept the listing's published terms without editing them
--
-- "buy_now" is intentionally a booking request rather than an immediate
-- charge. The owner still confirms availability before the existing Stripe
-- checkout flow opens. That keeps the label honest for listings with dates,
-- lead time, or a payout account that still needs attention.

alter table public.campaign_requests
  add column if not exists purchase_mode text not null default 'offer';

alter table public.campaign_requests
  drop constraint if exists campaign_requests_purchase_mode_check,
  add constraint campaign_requests_purchase_mode_check
    check (purchase_mode in ('offer', 'buy_now'));

comment on column public.campaign_requests.purchase_mode is
  'offer lets the buyer propose terms; buy_now snapshots the listing terms and cannot be countered.';

-- Browser inserts may use the flexible offer path directly. The fixed path is
-- also allowed through the same RLS boundary, but only when its economic terms
-- exactly match the active listing. This keeps a modified browser request
-- from masquerading as a book-as-listed action.
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
          and campaign_requests.budget_cents = listing.price_cents
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
          and campaign_requests.start_date >= current_date + listing.lead_time_days
        )
      )
  )
);

-- Keep a fixed booking fixed after insertion and make a direct RPC attempt to
-- counter it fail closed. The existing browser UPDATE grant is already
-- revoked; this trigger also protects privileged server-side paths from
-- accidentally turning a book-as-listed row into an offer.
create or replace function private.protect_book_as_listed_terms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.purchase_mode is distinct from old.purchase_mode then
      raise exception 'A booking mode cannot change after the offer is sent.';
    end if;

    if old.purchase_mode = 'buy_now' and new.status = 'countered' then
      raise exception 'A book-as-listed request cannot be countered. Send an offer instead.';
    end if;

    if old.purchase_mode = 'buy_now' and (
      new.listing_id is distinct from old.listing_id
      or new.requester_profile_id is distinct from old.requester_profile_id
      or new.owner_profile_id is distinct from old.owner_profile_id
      or new.requested_deliverables is distinct from old.requested_deliverables
      or new.budget_cents is distinct from old.budget_cents
      or new.start_date is distinct from old.start_date
      or new.end_date is distinct from old.end_date
      or new.counter_budget_cents is distinct from old.counter_budget_cents
      or new.counter_message is distinct from old.counter_message
    ) then
      raise exception 'Book-as-listed terms are immutable.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_book_as_listed_terms on public.campaign_requests;
create trigger protect_book_as_listed_terms
before update on public.campaign_requests
for each row execute function private.protect_book_as_listed_terms();

revoke all on function private.protect_book_as_listed_terms()
  from public, anon, authenticated;
