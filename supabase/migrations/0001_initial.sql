create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  role text not null default 'consumer'
    check (role in ('consumer', 'business', 'creator', 'space_owner')),
  display_name text not null,
  handle text,
  bio text not null default '',
  city text not null default '',
  categories text[] not null default '{}',
  followers integer not null default 0 check (followers >= 0),
  avg_views integer not null default 0 check (avg_views >= 0),
  audience_age text not null default '',
  website text not null default '',
  avatar_url text not null default '',
  verified boolean not null default false,
  is_demo boolean not null default false,
  onboarding_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint real_profiles_have_auth check (is_demo or auth_user_id is not null)
);

create unique index if not exists profiles_handle_unique
  on public.profiles (lower(handle))
  where handle is not null and handle <> '';
create index if not exists profiles_role_idx on public.profiles (role);
create index if not exists profiles_city_idx on public.profiles (city);

create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  channel text not null,
  format text not null,
  price integer not null check (price > 0),
  price_unit text not null default 'campaign',
  description text not null default '',
  demographics text not null default '',
  image_url text not null default '',
  status text not null default 'active'
    check (status in ('active', 'paused', 'booked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists listings_owner_idx
  on public.listings (owner_profile_id);
create index if not exists listings_status_created_idx
  on public.listings (status, created_at desc);
create index if not exists listings_channel_idx
  on public.listings (channel);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  participant_a uuid not null references public.profiles(id) on delete cascade,
  participant_b uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_distinct_members check (participant_a <> participant_b),
  constraint conversations_sorted_pair check (participant_a::text < participant_b::text),
  constraint conversations_unique_pair unique (participant_a, participant_b)
);

create index if not exists conversations_a_updated_idx
  on public.conversations (participant_a, updated_at desc);
create index if not exists conversations_b_updated_idx
  on public.conversations (participant_b, updated_at desc);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_profile_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists listings_set_updated_at on public.listings;
create trigger listings_set_updated_at
before update on public.listings
for each row execute function public.set_updated_at();

create or replace function public.bump_conversation_after_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
  set updated_at = now()
  where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists messages_bump_conversation on public.messages;
create trigger messages_bump_conversation
after insert on public.messages
for each row execute function public.bump_conversation_after_message();

create or replace function public.reply_from_demo_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  demo_recipient uuid;
  demo_role text;
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  select candidate.id, candidate.role
  into demo_recipient, demo_role
  from public.conversations conversation
  join public.profiles candidate
    on candidate.id = case
      when conversation.participant_a = new.sender_profile_id
        then conversation.participant_b
      else conversation.participant_a
    end
  where conversation.id = new.conversation_id
    and candidate.is_demo
    and not exists (
      select 1
      from public.messages prior
      where prior.conversation_id = new.conversation_id
        and prior.sender_profile_id = candidate.id
    );

  if demo_recipient is not null then
    insert into public.messages (
      conversation_id,
      sender_profile_id,
      body
    )
    values (
      new.conversation_id,
      demo_recipient,
      case demo_role
        when 'creator' then
          'Demo reply — Thanks for reaching out. Share your campaign goal, timing, and the audience you want to reach, and I’ll show you how a creator conversation works here.'
        when 'space_owner' then
          'Demo reply — Thanks for the note. Tell me your dates, artwork size, and neighborhood goal, and I’ll show you how a space booking conversation works here.'
        else
          'Demo reply — Great to meet you. Share a little about your audience or space, and I’ll show you how a business partnership conversation works here.'
      end
    );
  end if;

  return new;
end;
$$;

drop trigger if exists messages_demo_reply on public.messages;
create trigger messages_demo_reply
after insert on public.messages
for each row execute function public.reply_from_demo_profile();

alter table public.profiles enable row level security;
alter table public.listings enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

drop policy if exists "Profiles are publicly readable" on public.profiles;
create policy "Profiles are publicly readable"
on public.profiles for select
using (onboarding_complete or auth_user_id = auth.uid());

drop policy if exists "Members create their own profile" on public.profiles;
create policy "Members create their own profile"
on public.profiles for insert
to authenticated
with check (auth_user_id = auth.uid() and not is_demo);

drop policy if exists "Members update their own profile" on public.profiles;
create policy "Members update their own profile"
on public.profiles for update
to authenticated
using (auth_user_id = auth.uid())
with check (auth_user_id = auth.uid() and not is_demo);

drop policy if exists "Active listings are public" on public.listings;
create policy "Active listings are public"
on public.listings for select
using (
  status = 'active'
  or exists (
    select 1 from public.profiles
    where profiles.id = listings.owner_profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "Members create their own listings" on public.listings;
create policy "Members create their own listings"
on public.listings for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = listings.owner_profile_id
      and profiles.auth_user_id = auth.uid()
      and profiles.onboarding_complete
      and profiles.role <> 'consumer'
  )
);

drop policy if exists "Members update their own listings" on public.listings;
create policy "Members update their own listings"
on public.listings for update
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = listings.owner_profile_id
      and profiles.auth_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = listings.owner_profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "Members delete their own listings" on public.listings;
create policy "Members delete their own listings"
on public.listings for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = listings.owner_profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "Participants read conversations" on public.conversations;
create policy "Participants read conversations"
on public.conversations for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.auth_user_id = auth.uid()
      and profiles.id in (conversations.participant_a, conversations.participant_b)
  )
);

drop policy if exists "Participants start conversations" on public.conversations;
create policy "Participants start conversations"
on public.conversations for insert
to authenticated
with check (
  participant_a::text < participant_b::text
  and exists (
    select 1 from public.profiles
    where profiles.auth_user_id = auth.uid()
      and profiles.id in (conversations.participant_a, conversations.participant_b)
      and profiles.onboarding_complete
  )
);

drop policy if exists "Participants read messages" on public.messages;
create policy "Participants read messages"
on public.messages for select
to authenticated
using (
  exists (
    select 1
    from public.conversations
    join public.profiles
      on profiles.id in (
        conversations.participant_a,
        conversations.participant_b
      )
    where conversations.id = messages.conversation_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "Participants send messages" on public.messages;
create policy "Participants send messages"
on public.messages for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles sender
    join public.conversations
      on conversations.id = messages.conversation_id
    where sender.id = messages.sender_profile_id
      and sender.auth_user_id = auth.uid()
      and sender.id in (
        conversations.participant_a,
        conversations.participant_b
      )
  )
);

alter table public.messages replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end;
$$;

insert into public.profiles (
  id, auth_user_id, role, display_name, handle, bio, city, categories,
  followers, avg_views, audience_age, website, avatar_url, verified, is_demo,
  onboarding_complete
)
values
  (
    '11111111-1111-4111-8111-111111111111', null, 'creator',
    'Maya Alvarez', '@mayaonfilm',
    'Analog fashion, thrift finds, and honest city guides for a community that actually shows up.',
    'East LA, CA', array['Instagram', 'Fashion', 'Local'], 18400, 8200,
    '72% ages 18–29', '', '/photos/market-creator.jpg', true, true, true
  ),
  (
    '22222222-2222-4222-8222-222222222222', null, 'creator',
    'Drew Kim', '@drew.eats',
    'No-frills food reviews and weekly neighborhood roundups. My audience follows for what to order tonight.',
    'Oakland, CA', array['TikTok', 'Food', 'Local'], 11700, 12100,
    '61% ages 21–34', '', '/photos/drew-kitchen.jpg', true, true, true
  ),
  (
    '33333333-3333-4333-8333-333333333333', null, 'space_owner',
    'Jay Morrison', 'Silver ’84 Volvo',
    'A restored wagon parked in a high-footfall arts district and driven through downtown every weekday.',
    'Portland, OR', array['Vehicle', 'Physical', 'Local'], 0, 31000,
    'Commuters + arts district', '', '/photos/jay-volvo.jpg', true, true, true
  ),
  (
    '44444444-4444-4444-8444-444444444444', null, 'space_owner',
    'Campus Corner', 'Student-run space network',
    'Storefront windows and benches along the busiest off-campus routes.',
    'Tempe, AZ', array['Campus', 'Storefront', 'Gen Z'], 0, 48000,
    '83% ages 18–24', '', '/photos/cafe-patio.jpg', true, true, true
  ),
  (
    '55555555-5555-4555-8555-555555555555', null, 'business',
    'Sunroom Coffee', '@sunroomcoffee',
    'A neighborhood coffee bar opening its second location and looking for local launch partners.',
    'Los Angeles, CA', array['Food', 'Local', 'Launch'], 6200, 4500,
    'Coffee, design, local life', 'sunroom.example', '/photos/sunroom-cafe.jpg',
    true, true, true
  ),
  (
    '66666666-6666-4666-8666-666666666666', null, 'business',
    'Good Bones Studio', '@goodbonesprints',
    'Independent art prints and frames made for renters, first homes, and rooms with personality.',
    'Atlanta, GA', array['Home', 'Design', 'Product'], 8700, 5300,
    'Renters and first homes', 'goodbones.example', '/photos/corner-store.jpg',
    false, true, true
  )
on conflict (id) do nothing;

insert into public.listings (
  id, owner_profile_id, title, channel, format, price, price_unit,
  description, demographics, image_url, status
)
values
  (
    'a1111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'Story set + saved highlight', 'Instagram',
    '3 frames · 48 hr highlight', 145, 'campaign',
    'A natural three-frame story with a clear call to action, kept in my Local Finds highlight.',
    '72% ages 18–29 · East LA', '/photos/market-creator.jpg', 'active'
  ),
  (
    'a2222222-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'An honest neighborhood food feature', 'TikTok',
    '30–45 sec · link in bio', 220, 'video',
    'One fast, useful food feature filmed on location and posted when my local audience is most active.',
    '61% ages 21–34 · Oakland', '/photos/drew-kitchen.jpg', 'active'
  ),
  (
    'a3333333-3333-4333-8333-333333333333',
    '33333333-3333-4333-8333-333333333333',
    'Rear-window campaign', 'Vehicle',
    '18 × 24 in · weather-safe', 85, 'week',
    'Rear-window placement on a vintage wagon that moves through Portland’s east-side neighborhoods.',
    '31K weekly looks · commuter route', '/photos/jay-volvo.jpg', 'active'
  ),
  (
    'a4444444-4444-4444-8444-444444444444',
    '44444444-4444-4444-8444-444444444444',
    'Two-location campus run', 'Storefront',
    '2 placements · weekly proof', 160, 'week',
    'Two high-visibility placements near campus with timestamped setup and weekly proof photos.',
    '48K weekly looks · 83% ages 18–24', '/photos/cafe-patio.jpg', 'active'
  ),
  (
    'a5555555-5555-4555-8555-555555555555',
    '55555555-5555-4555-8555-555555555555',
    'Second-store launch partners', 'Business brief',
    'Stories · tasting · street placement', 250, 'partner',
    'Paid launch brief for creators and spaces with a genuine connection to neighborhood coffee culture.',
    'Local coffee, design, and culture', '/photos/sunroom-cafe.jpg', 'active'
  )
on conflict (id) do nothing;
