-- Three RLS/grant gaps found by review.
--
-- 1. campaign_requests had SELECT and INSERT policies but no UPDATE policy,
--    while the client writes conversation_id back after opening a thread. With
--    RLS on and no policy, that UPDATE matches zero rows and returns success,
--    so the failure was invisible: every campaign request created alongside a
--    new conversation kept conversation_id null forever.
-- 2. The marketplace-media SELECT policy let any caller LIST the whole bucket,
--    not just fetch a known URL.
-- 3. profiles is publicly readable by design, but anon had no reason to read
--    auth_user_id, verification_status or social_verification.

-- ---------------------------------------------------------------------------
-- 1. Let a requester attach a conversation to their own request, once.
-- ---------------------------------------------------------------------------
drop policy if exists "Requester links conversation" on public.campaign_requests;
create policy "Requester links conversation"
on public.campaign_requests for update to authenticated
using (
  -- Only the requester, only while the link is still unset. Once
  -- conversation_id is populated the row stops being updatable again.
  conversation_id is null
  and exists (
    select 1 from public.profiles
    where profiles.id = campaign_requests.requester_profile_id
      and profiles.auth_user_id = (select auth.uid())
  )
)
with check (
  conversation_id is not null
  and exists (
    select 1 from public.profiles
    where profiles.id = campaign_requests.requester_profile_id
      and profiles.auth_user_id = (select auth.uid())
  )
  -- Pin every other column to its current value, so this policy can only ever
  -- be used to set the link and never to edit budget, status or terms.
  and status = 'pending'
  and counter_budget is null
  and counter_message = ''
  -- The conversation must be one the requester actually belongs to.
  and exists (
    select 1
    from public.conversations c
    join public.profiles p on p.auth_user_id = (select auth.uid())
    where c.id = campaign_requests.conversation_id
      and p.id in (c.participant_a, c.participant_b)
  )
);

-- ---------------------------------------------------------------------------
-- 2. Stop anonymous enumeration of the media bucket.
-- ---------------------------------------------------------------------------
-- The bucket is already public = true (0003), which serves reads over
-- /object/public/... without any SELECT policy. The blanket policy added on top
-- of that granted storage.objects SELECT, which is what powers list() - so
-- anyone could enumerate every uploaded file rather than only fetching URLs
-- they had already been given.
drop policy if exists "Marketplace media is publicly readable" on storage.objects;

-- Authenticated members keep listing access to their own folder, which is what
-- the upload and remove flows actually need.
drop policy if exists "Members list own marketplace media" on storage.objects;
create policy "Members list own marketplace media"
on storage.objects for select to authenticated
using (
  bucket_id = 'marketplace-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- ---------------------------------------------------------------------------
-- 3. Trim what anonymous callers can read off profiles.
-- ---------------------------------------------------------------------------
-- Narrowed for anon only. `authenticated` keeps full-table SELECT because
-- loading your own profile filters on auth_user_id, and Postgres requires
-- SELECT on a column to reference it even in a WHERE clause.
--
-- Note the order: revoking a *column* privilege from a role that holds the
-- *table* privilege leaves the table privilege intact, so the table grant has
-- to come off first and the safe columns be granted back explicitly.
revoke select on public.profiles from anon;
grant select (
  id,
  role,
  display_name,
  handle,
  bio,
  city,
  categories,
  followers,
  avg_views,
  audience_age,
  website,
  avatar_url,
  verified,
  is_demo,
  is_internal,
  onboarding_complete,
  extra_roles,
  social_links,
  gallery_urls,
  created_at,
  updated_at
) on public.profiles to anon;
