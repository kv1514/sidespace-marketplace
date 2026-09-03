-- A walkthrough of the space from its owner: a plain video, a 360 video, or
-- a 360 photo, so a buyer can see the actual place and how people move
-- through it. SideSpace hosts these - they are the owner's, unlike Street
-- View, which is Google's and may only be shown live - in a bucket of their
-- own: the photo bucket's 8 MB ceiling fits a photo, not a minute of phone
-- video, and adding video types to it would let every image field take a
-- video. 50 MB is the largest object the project's plan accepts.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'marketplace-tours',
  'marketplace-tours',
  true,
  52428800,
  array['video/mp4', 'video/webm', 'video/quicktime', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Same shape as marketplace-media after 0013: a public bucket serves a URL
-- with no SELECT policy at all, and a blanket one would let anyone list every
-- file. Members list, write and delete only inside their own folder.
drop policy if exists "Members list own walkthroughs" on storage.objects;
create policy "Members list own walkthroughs"
on storage.objects for select to authenticated
using (
  bucket_id = 'marketplace-tours'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Members upload their walkthroughs" on storage.objects;
create policy "Members upload their walkthroughs"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'marketplace-tours'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Members update their walkthroughs" on storage.objects;
create policy "Members update their walkthroughs"
on storage.objects for update to authenticated
using (
  bucket_id = 'marketplace-tours'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'marketplace-tours'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Members delete their walkthroughs" on storage.objects;
create policy "Members delete their walkthroughs"
on storage.objects for delete to authenticated
using (
  bucket_id = 'marketplace-tours'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- One walkthrough per listing. tour_kind says how to show it: 'video' plays
-- flat, 'video360' and 'photo360' open in the panorama viewer.
alter table public.listings
  add column if not exists tour_url text not null default '',
  add column if not exists tour_kind text not null default '';

alter table public.listings drop constraint if exists listings_tour_kind_valid;
alter table public.listings
  add constraint listings_tour_kind_valid
  check (tour_kind in ('', 'video', 'video360', 'photo360'));

alter table public.listings drop constraint if exists listings_tour_url_len;
alter table public.listings
  add constraint listings_tour_url_len
  check (char_length(tour_url) <= 600);

-- Both set or both empty: a kind without a file, or a file without a kind,
-- has no rendering.
alter table public.listings drop constraint if exists listings_tour_paired;
alter table public.listings
  add constraint listings_tour_paired
  check ((tour_url = '') = (tour_kind = ''));

comment on column public.listings.tour_url is
  'Public URL of the owner''s walkthrough in the marketplace-tours bucket: a video, a 360 video, or a 360 photo. Empty when none.';
comment on column public.listings.tour_kind is
  'How to show tour_url: video (flat), video360 or photo360 (panorama viewer). Empty when none.';

-- Public like the photos: the walkthrough renders wherever the listing does.
-- See 0020 for why every public column needs its own grant.
grant select (tour_url, tour_kind) on public.listings to anon, authenticated;

create or replace view public.my_listings
with (security_invoker = true, security_barrier = true) as
select
  id, owner_profile_id, title, channel, format, price_cents, price_unit,
  description, demographics, image_url, status, created_at, updated_at,
  image_urls, location_area, availability_notes, available_from, available_to,
  lead_time_days, minimum_booking, deliverables, cancellation_policy,
  price_max_cents, brief_scope, target_platforms, street_address,
  surface_types, install_by, space_size, sponsor_tier, sponsor_slots,
  provenance_status, availability_confirmed_at, instant_booking_enabled,
  availability_dates, booking_duration_days, booking_timezone,
  street_view_captured, street_view_pano, tour_url, tour_kind
from private.current_user_listing_rows() listing(
  id, owner_profile_id, title, channel, format, price_cents, price_unit,
  description, demographics, image_url, status, created_at, updated_at,
  image_urls, location_area, availability_notes, available_from, available_to,
  lead_time_days, minimum_booking, deliverables, cancellation_policy,
  price_max_cents, brief_scope, target_platforms, street_address,
  surface_types, install_by, space_size, sponsor_tier, sponsor_slots,
  provenance_status, availability_confirmed_at, instant_booking_enabled,
  availability_dates, booking_duration_days, booking_timezone,
  street_view_captured, street_view_pano, tour_url, tour_kind
);
