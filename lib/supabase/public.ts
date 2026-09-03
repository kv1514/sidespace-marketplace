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
/**
 * What a cold-email recipient's invite link tells us about them.
 *
 * Everything here is already published on the business's own website - that is
 * where we found it. public.invite_prospect deliberately does not return their
 * email address, the hook we wrote about them, or the URLs we researched: a
 * link gets forwarded, and none of our notes should travel with it.
 *
 * Lives here rather than in app/page.tsx so the client component can name the
 * type without importing from a server module.
 */
export type Invite = {
  business: string;
  city: string;
  category: string;
  owner_first_name: string | null;
  intent: string;
  has_physical_space: boolean;
};

export const PUBLIC_PROFILE_COLUMNS =
  "id,role,display_name,handle,bio,city,categories,followers,avg_views,reach_unit,audience_age,website,avatar_url,verified,is_demo,onboarding_complete,extra_roles,social_links,gallery_urls,created_at,updated_at";

/**
 * Listing columns safe to serve to anyone, including signed-out visitors.
 *
 * This exists for exactly one column. `listings.street_address` is the exact
 * address of someone's shop or home, collected so a space owner can check the
 * map link while filling the form. Nothing renders it - but the marketplace
 * grid was fetched with `select("*")`, so it travelled in the page payload to
 * every anonymous visitor and every crawler.
 *
 * The owner still gets the whole row through the database-owned `my_listings`
 * projection, so editing an address still works. Only public reads are
 * narrowed.
 *
 * A column added later is absent here until someone adds it, so it stays out
 * of the public payload by default. That is the safe direction to fail, and it
 * is the same trade-off PUBLIC_PROFILE_COLUMNS already makes.
 *
 * ADDING A COLUMN TO public.listings? Migration 0020 revoked the table-wide
 * SELECT grant from `anon` and granted the columns back one by one, so a new
 * column is unreadable by signed-out visitors until its migration carries
 *
 *     grant select (new_column) on public.listings to anon;
 *
 * If the column belongs in this list, it needs that grant too. Forgetting it
 * surfaces as the public marketplace failing to load, not a missing field.
 */
export const PUBLIC_LISTING_COLUMNS =
  "id,owner_profile_id,title,channel,format,price_cents,price_unit,description,demographics,image_url,status,created_at,updated_at,image_urls,location_area,availability_notes,available_from,available_to,lead_time_days,minimum_booking,deliverables,cancellation_policy,price_max_cents,brief_scope,target_platforms,surface_types,install_by,space_size,sponsor_tier,sponsor_slots,provenance_status,availability_confirmed_at,instant_booking_enabled,availability_dates,booking_duration_days,booking_timezone,street_view_captured";

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
