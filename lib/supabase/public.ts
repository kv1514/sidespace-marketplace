import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Profile columns safe to serve to anyone, including signed-out visitors.
 *
 * `profiles` is publicly readable by design - the marketplace has to render for
 * crawlers and logged-out browsers - but `select("*")` handed anonymous callers
 * three columns they have no use for: `auth_user_id` (the auth.users UUID),
 * `verification_status` and `social_verification` (someone's review state,
 * including a rejection). None of the three is read anywhere in the client, so
 * naming columns explicitly costs nothing and stops sending them.
 */
export const PUBLIC_PROFILE_COLUMNS =
  "id,role,display_name,handle,bio,city,categories,followers,avg_views,audience_age,website,avatar_url,verified,is_demo,is_internal,onboarding_complete,extra_roles,social_links,gallery_urls,created_at,updated_at";

/**
 * Anonymous, cookie-free Supabase client for public data.
 *
 * The server client in ./server.ts calls `cookies()`, and reading cookies opts
 * a route into dynamic rendering - which silently defeated `revalidate` on the
 * homepage: the page declared ISR while every single request re-rendered and
 * blocked on two Supabase round trips.
 *
 * Nothing here is per-user. The marketplace grid and the people showcase are
 * the same for everyone, so they are fetched with the publishable key and no
 * session at all, letting the page actually sit on the CDN.
 */
export function createPublicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error("Supabase environment variables are missing.");
  }

  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
