import {
  createPublicClient,
  PUBLIC_LISTING_COLUMNS,
  PUBLIC_PROFILE_COLUMNS,
  type Invite,
} from "@/lib/supabase/public";
import { localListingSeeds, localProfiles } from "@/app/localMarketplaceData";
import type { ListingSocialPreview } from "@/lib/site-metadata";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PublicListingPreview = ListingSocialPreview & {
  channel: string;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return record(value[0]);
  }
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function normalizePublicListingPreview(
  value: unknown,
): PublicListingPreview | null {
  const row = record(value);
  if (!row || row.status !== "active") return null;

  const id = text(row.id);
  const title = text(row.title);
  const channel = text(row.channel);
  if (!id || !title || !channel) return null;

  const owner = record(row.owner);
  const imageUrls = Array.isArray(row.image_urls)
    ? row.image_urls.filter((item): item is string => typeof item === "string")
    : [];

  return {
    id,
    title,
    channel,
    format: text(row.format) || null,
    description: text(row.description) || null,
    imageUrl: text(row.image_url) || null,
    imageUrls,
    locationArea: text(row.location_area) || null,
    ownerName: text(owner?.display_name) || null,
    ownerCity: text(owner?.city) || null,
  };
}

function localListingPreview(listingId: string) {
  const listing = localListingSeeds.find((item) => item.id === listingId);
  if (!listing) return null;
  const owner = localProfiles.find(
    (profile) => profile.id === listing.owner_profile_id,
  );
  if (!owner) return null;

  return normalizePublicListingPreview({
    ...listing,
    owner,
  });
}

export function isInviteToken(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Load only the public fields needed to render a listing link preview. */
export async function loadPublicListing(
  listingId: unknown,
): Promise<PublicListingPreview | null> {
  if (typeof listingId !== "string" || !UUID.test(listingId)) return null;

  const configured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
  if (!configured) return localListingPreview(listingId);

  try {
    const supabase = createPublicClient();
    const { data, error } = await supabase
      .from("listings")
      .select(
        "id,title,channel,format,description,image_url,image_urls,location_area,status,owner:profiles!listings_owner_profile_id_fkey(id,display_name,city)",
      )
      .eq("id", listingId)
      .eq("status", "active")
      .maybeSingle();
    if (error) {
      console.error("[listing metadata] listing fetch failed:", error);
      return null;
    }
    return normalizePublicListingPreview(data);
  } catch (error) {
    console.error("[listing metadata] listing fetch threw:", error);
    return null;
  }
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

export async function loadReferralCredit(code: string): Promise<number | null> {
  if (!code) return null;
  try {
    const supabase = createPublicClient();
    const { data, error } = await supabase.rpc(
      "lookup_business_referral_offer",
      { referral_code: code },
    );
    if (error) {
      console.error("[public] referral lookup failed:", error);
      return null;
    }
    const amount = Number(data);
    return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
  } catch (error) {
    console.error("[public] referral lookup threw:", error);
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
        .from("marketplace_profiles")
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
