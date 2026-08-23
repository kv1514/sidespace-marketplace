import MarketplaceApp from "./MarketplaceApp";
import {
  createPublicClient,
  PUBLIC_PROFILE_COLUMNS,
} from "@/lib/supabase/public";

// Revalidate rather than render per request: the marketplace changes slowly and
// this keeps the page on the CDN.
export const revalidate = 300;

/**
 * Fetch the marketplace on the server so the HTML actually contains real
 * members and listings.
 *
 * Without this the first paint is the seeded demo marketplace and the real data
 * only arrives after the client hydrates and queries Supabase - so every
 * crawler, link unfurler (Slack, iMessage, LinkedIn) and AI search bot saw a
 * marketplace of invented businesses and never a real one. The same query runs
 * again on the client, so a stale cache self-corrects within a second.
 */
export default async function Home() {
  let profiles = null;
  let listings = null;

  try {
    // Cookie-free on purpose. The session-aware server client calls cookies(),
    // which opts this route into dynamic rendering and made `revalidate = 300`
    // above a no-op: every request re-rendered and blocked on these queries.
    // None of this data is per-user, so it does not need a session.
    const supabase = createPublicClient();
    const [profilesResult, listingsResult] = await Promise.all([
      supabase
        .from("profiles")
        .select(PUBLIC_PROFILE_COLUMNS)
        .eq("onboarding_complete", true)
        .neq("role", "consumer")
        .order("verified", { ascending: false })
        // Same reasoning as the listings bound below - this fed an uncapped
        // showcase row that rendered a card per profile.
        .limit(60),
      supabase
        .from("listings")
        .select(
          `*, owner:profiles!listings_owner_profile_id_fkey(${PUBLIC_PROFILE_COLUMNS})`,
        )
        .eq("status", "active")
        .order("created_at", { ascending: false })
        // Bound the payload: PostgREST truncates at 1000 anyway, silently.
        .limit(200),
    ]);
    profiles = profilesResult.error ? null : profilesResult.data;
    listings = listingsResult.error ? null : listingsResult.data;
  } catch {
    // Supabase unreachable at build or request time: fall through with nulls
    // and let the client seed itself exactly as it did before.
    profiles = null;
    listings = null;
  }

  return <MarketplaceApp initialProfiles={profiles} initialListings={listings} />;
}
