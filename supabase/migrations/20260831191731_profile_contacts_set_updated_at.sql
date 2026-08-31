-- profile_contacts.updated_at was frozen at insert time.
--
-- The table was created with `updated_at timestamptz not null default now()`
-- but no trigger, so the column only ever recorded the INSERT. Every other
-- table carrying this column - profiles, listings and the rest - already has
-- the shared public.set_updated_at() trigger from 0001. This one was missed.
--
-- Found while driving the save path end to end in a real browser: two
-- successive upserts returned different values with an identical updated_at.
-- It also made "has anything written to this table since the backfill?"
-- unanswerable from the column, which is the question it exists to answer,
-- and one that was actually asked while diagnosing a save that never landed.

drop trigger if exists profile_contacts_set_updated_at on public.profile_contacts;
create trigger profile_contacts_set_updated_at
before update on public.profile_contacts
for each row execute function public.set_updated_at();
