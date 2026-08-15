alter table public.profiles
  add column if not exists social_links jsonb not null default '{}'::jsonb,
  add column if not exists gallery_urls text[] not null default '{}';

alter table public.listings
  add column if not exists image_urls text[] not null default '{}';

update public.listings
set image_urls = array[image_url]
where cardinality(image_urls) = 0
  and image_url <> '';

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'marketplace-media',
  'marketplace-media',
  true,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Marketplace media is publicly readable" on storage.objects;
create policy "Marketplace media is publicly readable"
on storage.objects for select
using (bucket_id = 'marketplace-media');

drop policy if exists "Members upload their marketplace media" on storage.objects;
create policy "Members upload their marketplace media"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'marketplace-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Members update their marketplace media" on storage.objects;
create policy "Members update their marketplace media"
on storage.objects for update
to authenticated
using (
  bucket_id = 'marketplace-media'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'marketplace-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Members delete their marketplace media" on storage.objects;
create policy "Members delete their marketplace media"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'marketplace-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);

update public.profiles
set social_links = jsonb_build_object(
  'instagram', 'https://instagram.com/mayaonfilm'
)
where id = '11111111-1111-4111-8111-111111111111';

update public.profiles
set social_links = jsonb_build_object(
  'tiktok', 'https://tiktok.com/@drew.eats',
  'instagram', 'https://instagram.com/drew.eats'
)
where id = '22222222-2222-4222-8222-222222222222';

update public.profiles
set social_links = jsonb_build_object(
  'instagram', 'https://instagram.com/mainstreetmakers',
  'youtube', 'https://youtube.com/@mainstreetmakers'
)
where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

update public.profiles
set gallery_urls = array['/photos/jay-volvo.jpg', '/photos/rural-main-street.jpg']
where id = '33333333-3333-4333-8333-333333333333';

update public.profiles
set gallery_urls = array['/photos/small-town-coffee.jpg', '/photos/rural-main-street.jpg']
where id = '44444444-4444-4444-8444-444444444444';

update public.profiles
set gallery_urls = array['/photos/roadside-farm-stand.jpg', '/photos/rural-main-street.jpg']
where id = '77777777-7777-4777-8777-777777777777';

update public.profiles
set gallery_urls = array['/photos/rural-market.jpg', '/photos/rural-main-street.jpg']
where id = '88888888-8888-4888-8888-888888888888';

update public.profiles
set gallery_urls = array['/photos/small-town-barber.jpg', '/photos/rural-main-street.jpg']
where id = '99999999-9999-4999-8999-999999999999';

update public.profiles
set gallery_urls = array['/photos/small-town-bakery.jpg', '/photos/rural-main-street.jpg']
where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

update public.profiles
set gallery_urls = array['/photos/small-town-coffee.jpg', '/photos/rural-main-street.jpg']
where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

update public.listings
set image_urls = array['/photos/jay-volvo.jpg', '/photos/rural-main-street.jpg']
where id = 'a3333333-3333-4333-8333-333333333333';

update public.listings
set image_urls = array['/photos/small-town-coffee.jpg', '/photos/rural-main-street.jpg']
where id = 'a4444444-4444-4444-8444-444444444444';

update public.listings
set image_urls = array['/photos/roadside-farm-stand.jpg', '/photos/rural-main-street.jpg']
where id = 'a7777777-7777-4777-8777-777777777777';

update public.listings
set image_urls = array['/photos/rural-market.jpg', '/photos/rural-main-street.jpg']
where id = 'a8888888-8888-4888-8888-888888888888';

update public.listings
set image_urls = array['/photos/small-town-barber.jpg', '/photos/rural-main-street.jpg']
where id = 'a9999999-9999-4999-8999-999999999999';

update public.listings
set image_urls = array['/photos/small-town-bakery.jpg', '/photos/rural-main-street.jpg']
where id = 'b1111111-1111-4111-8111-111111111111';
