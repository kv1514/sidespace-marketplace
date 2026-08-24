import MarketplaceApp from "./MarketplaceApp";
import {
  createPublicClient,
  PUBLIC_PROFILE_COLUMNS,
} from "@/lib/supabase/public";

// Render per request, deliberately.
//
// This was briefly `revalidate = 300`, which is worse than it sounds for this
// page: Next prerenders it at BUILD time, so whatever the build machine's fetch
// returned gets baked into the HTML every visitor receives. When that fetch came
// back empty the homepage served the demo seed fallback - twelve invented
// businesses in Ohio and Montana - and none of the real listings, with no error
// anywhere because the catch below is doing its job.
//
// A marketplace's homepage IS its live data. Caching it on the CDN trades the
// one thing the page exists to show for a few hundred milliseconds.
export const dynamic = "force-dynamic";

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
    // Cookie-free on purpose: none of this data is per-user, so it does not
    // need a session, and avoiding cookies() keeps the fetch independent of
    // request context.
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
    // Log loudly. Falling through to null silently swaps the real marketplace
    // for twelve invented demo businesses, which looks like a working page and
    // is the hardest kind of failure to notice - it took a founder saying "where
    // are my listings" to catch it, because nothing errored.
    if (profilesResult.error) {
      console.error("[home] profiles fetch failed:", profilesResult.error);
    }
    if (listingsResult.error) {
      console.error("[home] listings fetch failed:", listingsResult.error);
    }
    profiles = profilesResult.error ? null : profilesResult.data;
    listings = listingsResult.error ? null : listingsResult.data;
  } catch (error) {
    // Supabase unreachable: fall through with nulls and let the client seed
    // itself, but say so in the logs rather than serving fiction in silence.
    console.error("[home] marketplace fetch threw:", error);
    profiles = null;
    listings = null;
  }

  return <MarketplaceApp initialProfiles={profiles} initialListings={listings} />;
}
