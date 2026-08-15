# Migration notes

The original SideSpace site uses Cloudflare D1 and ChatGPT/Sites authentication.
The new version uses Supabase Auth and Postgres so it can run as a regular public
Vercel website.

## Content already preserved

The six public sample profiles, five marketplace listings, and local photo
assets are included in the Supabase seed migration. They appear immediately
after the migration runs.

## Existing real account data

Do not copy password or session records. The old site never owned a reusable
password database, and ChatGPT identities cannot be silently converted into
Google or email/password credentials.

After Supabase is connected:

1. Export the D1 `profiles` and `listings` tables.
2. Import non-auth profile and listing fields into temporary Supabase tables.
3. Ask existing members to create a new Supabase account.
4. Match records by verified email and attach each imported profile to its new
   `auth.users.id`.
5. Import conversations only after both participants have claimed accounts.

Keep the original site online and read-only during this claim window. Switch the
domain after the migrated records and row-level-security checks have been
verified.

## Why this is a staged migration

Account ownership must be re-established through a verified email or OAuth
login. Automatically assigning old records to new identities would risk giving
the wrong person access to private messages or listings.
