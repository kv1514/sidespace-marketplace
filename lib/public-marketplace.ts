import {
  createPublicClient,
  PUBLIC_LISTING_COLUMNS,
  PUBLIC_PROFILE_COLUMNS,
  type Invite,
} from "@/lib/supabase/public";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isInviteToken(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export async function loadInvite(token: unknown): Promise<Invite | null> {
  if (!isInviteToken(token)) return null;
  try {
    const supabase = createPublicClient();
    const { data, error } = await supabase
      .rpc("invite_prospect", { token })
      .maybeSingle();
    if (error) {
      console.error("[public] invite lookup failed:", error);
      return null;
    }
    return (data as Invite) ?? null;
  } catch (error) {
    console.error("[public] invite lookup threw:", error);
    return null;
  }
}

export async function loadMarketplaceSnapshot({
  profileLimit,
  listingLimit,
  label,
}: {
  profileLimit: number;
  listingLimit: number;
  label: string;
}) {
  let profiles = null;
  let listings = null;

  try {
    const supabase = createPublicClient();
    const [profilesResult, listingsResult] = await Promise.all([
      supabase
        .from("profiles")
        .select(PUBLIC_PROFILE_COLUMNS)
        .eq("onboarding_complete", true)
        .neq("role", "consumer")
        .order("verified", { ascending: false })
        .limit(profileLimit),
      supabase
        .from("listings")
        .select(
          `${PUBLIC_LISTING_COLUMNS}, owner:profiles!listings_owner_profile_id_fkey(${PUBLIC_PROFILE_COLUMNS})`,
        )
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(listingLimit),
    ]);

    if (profilesResult.error) {
      console.error(`[${label}] profiles fetch failed:`, profilesResult.error);
    }
    if (listingsResult.error) {
      console.error(`[${label}] listings fetch failed:`, listingsResult.error);
    }
    profiles = profilesResult.error ? null : profilesResult.data;
    listings = listingsResult.error ? null : listingsResult.data;
  } catch (error) {
    // Local visual review intentionally works without production credentials.
    // MarketplaceApp uses the existing, clearly-labelled demo fallback.
    console.error(`[${label}] marketplace fetch threw:`, error);
  }

  return { profiles, listings };
}
