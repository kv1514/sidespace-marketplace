-- Public Creator work samples and immutable reviews from verified completed
-- SideSpace campaigns. Reviews are tied one-to-one to the payment ledger so a
-- payer cannot review work they did not purchase.

create table public.creator_portfolio_items (
  id uuid primary key default gen_random_uuid(),
  creator_profile_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 2 and 120),
  description text not null default '' check (char_length(description) <= 1200),
  kind text not null default 'project'
    check (kind in ('video', 'project', 'campaign', 'case_study', 'other')),
  media_url text not null default '' check (char_length(media_url) <= 2000),
  project_url text not null default '' check (char_length(project_url) <= 2000),
  sort_order integer not null default 0 check (sort_order >= 0),
  published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creator_portfolio_has_evidence
    check (media_url <> '' or project_url <> '' or description <> ''),
  constraint creator_portfolio_media_url_safe
    check (media_url = '' or media_url ~* '^https://'),
  constraint creator_portfolio_project_url_safe
    check (project_url = '' or project_url ~* '^https://')
);

create index creator_portfolio_profile_order_idx
  on public.creator_portfolio_items (creator_profile_id, sort_order, created_at desc);

create table public.creator_reviews (
  id uuid primary key default gen_random_uuid(),
  payment_transaction_id uuid not null unique
    references public.payment_transactions(id) on delete restrict,
  payer_profile_id uuid not null references public.profiles(id) on delete restrict,
  creator_profile_id uuid not null references public.profiles(id) on delete restrict,
  rating smallint not null check (rating between 1 and 5),
  review_text text not null check (char_length(trim(review_text)) between 10 and 2000),
  created_at timestamptz not null default now(),
  constraint creator_review_parties_differ check (payer_profile_id <> creator_profile_id)
);

create index creator_reviews_creator_created_idx
  on public.creator_reviews (creator_profile_id, created_at desc);

drop trigger if exists creator_portfolio_items_set_updated_at on public.creator_portfolio_items;
create trigger creator_portfolio_items_set_updated_at
before update on public.creator_portfolio_items
for each row execute function public.set_updated_at();

alter table public.creator_portfolio_items enable row level security;
alter table public.creator_reviews enable row level security;

create or replace function private.reject_creator_review_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Completed-campaign reviews are immutable.';
end;
$$;

drop trigger if exists creator_reviews_immutable on public.creator_reviews;
create trigger creator_reviews_immutable
before update or delete on public.creator_reviews
for each row execute function private.reject_creator_review_mutation();

create policy "Published Creator portfolio is public"
on public.creator_portfolio_items for select to anon, authenticated
using (published);

create policy "Creators add their own portfolio items"
on public.creator_portfolio_items for insert to authenticated
with check (exists (
  select 1 from public.profiles profile
  where profile.id = creator_portfolio_items.creator_profile_id
    and profile.auth_user_id = (select auth.uid())
    and profile.role = 'creator'
));

create policy "Creators update their own portfolio items"
on public.creator_portfolio_items for update to authenticated
using (exists (
  select 1 from public.profiles profile
  where profile.id = creator_portfolio_items.creator_profile_id
    and profile.auth_user_id = (select auth.uid())
    and profile.role = 'creator'
))
with check (exists (
  select 1 from public.profiles profile
  where profile.id = creator_portfolio_items.creator_profile_id
    and profile.auth_user_id = (select auth.uid())
    and profile.role = 'creator'
));

create policy "Creators delete their own portfolio items"
on public.creator_portfolio_items for delete to authenticated
using (exists (
  select 1 from public.profiles profile
  where profile.id = creator_portfolio_items.creator_profile_id
    and profile.auth_user_id = (select auth.uid())
    and profile.role = 'creator'
));

create policy "Creator reviews are public"
on public.creator_reviews for select to anon, authenticated
using (true);

grant select on public.creator_portfolio_items to anon, authenticated;
grant insert, update, delete on public.creator_portfolio_items to authenticated;
grant select on public.creator_reviews to anon, authenticated;
grant all on public.creator_portfolio_items to service_role;
grant all on public.creator_reviews to service_role;

create or replace function public.create_creator_review(
  target_transaction_id uuid,
  actor_profile_id uuid,
  review_rating smallint,
  review_body text
)
returns public.creator_reviews
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction public.payment_transactions;
  review public.creator_reviews;
begin
  select * into transaction from public.payment_transactions
  where id = target_transaction_id for update;
  if transaction.id is null then raise exception 'Payment transaction not found.'; end if;
  if transaction.business_profile_id <> actor_profile_id then
    raise exception 'Only the payer can review this Creator.';
  end if;
  if transaction.payout_status <> 'released'
     or transaction.workflow_status <> 'completed' then
    raise exception 'A review can be added after the campaign is completed.';
  end if;
  select * into review from public.creator_reviews
  where payment_transaction_id = transaction.id;
  if review.id is not null then return review; end if;
  insert into public.creator_reviews (
    payment_transaction_id, payer_profile_id, creator_profile_id, rating, review_text
  ) values (
    transaction.id, actor_profile_id, transaction.creator_profile_id,
    review_rating, trim(review_body)
  ) returning * into review;
  return review;
end;
$$;

revoke all on function public.create_creator_review(uuid, uuid, smallint, text)
  from public, anon, authenticated;
grant execute on function public.create_creator_review(uuid, uuid, smallint, text)
  to service_role;

comment on table public.creator_reviews is
  'Immutable payer reviews backed by a completed, payout-released SideSpace campaign.';
