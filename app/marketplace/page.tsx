import type { Metadata } from "next";
import MarketplaceApp from "../MarketplaceApp";
import {
  loadMarketplaceSnapshot,
  loadPublicListing,
} from "@/lib/public-marketplace";
import {
  createListingSocialMetadata,
  OG_IMAGE,
} from "@/lib/site-metadata";

export const dynamic = "force-dynamic";

const MARKETPLACE_METADATA: Metadata = {
  alternates: { canonical: "/marketplace" },
  title: "Marketplace",
  description:
    "Browse creator listings for social audiences, physical placements, sponsorships, and business campaign briefs on SideSpace.",
  openGraph: {
    images: OG_IMAGE,
    url: "/marketplace",
    title: "Browse the SideSpace marketplace",
    description:
      "Search real local attention from creators: storefronts, vehicles, sponsorships, and more.",
  },
  twitter: {
    card: "summary_large_image",
    images: OG_IMAGE,
    title: "Browse the SideSpace marketplace",
    description:
      "Search real local attention from creators: storefronts, vehicles, sponsorships, and more.",
  },
};

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const params = await searchParams;
  const listingId = typeof params.listing === "string" ? params.listing : "";
  if (!listingId && params.sort === "popular") {
    return {
      ...MARKETPLACE_METADATA,
      alternates: { canonical: "/marketplace?sort=popular" },
      title: "Popular listings | SideSpace",
      description:
        "See the SideSpace listings the community is noticing, with freshness and listing quality helping new opportunities break through.",
      openGraph: {
        ...MARKETPLACE_METADATA.openGraph,
        url: "/marketplace?sort=popular",
        title: "Popular listings on SideSpace",
        description:
          "See the SideSpace listings the community is noticing, with freshness and listing quality helping new opportunities break through.",
      },
      twitter: {
        ...MARKETPLACE_METADATA.twitter,
        title: "Popular listings on SideSpace",
        description:
          "See the SideSpace listings the community is noticing, with freshness and listing quality helping new opportunities break through.",
      },
    };
  }
  if (!listingId) return MARKETPLACE_METADATA;

  const listing = await loadPublicListing(listingId);
  return listing
    ? createListingSocialMetadata(listing)
    : MARKETPLACE_METADATA;
}

const ROLE_FILTERS = new Set([
  "all",
  "supply",
  "business",
  "creator",
]);

export default async function Marketplace({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, snapshot] = await Promise.all([
    searchParams,
    loadMarketplaceSnapshot({
      profileLimit: 60,
      listingLimit: 200,
      label: "marketplace",
    }),
  ]);
  const intent = typeof params.intent === "string" ? params.intent : "";
  const requestedRole =
    intent === "advertise" || intent === "supply"
      ? "supply"
      : intent === "offer"
        ? "business"
        : typeof params.role === "string"
          ? params.role === "space_owner" || params.role === "sponsor_host"
            ? "creator"
            : ROLE_FILTERS.has(params.role)
              ? params.role
              : "all"
          : "all";
  const initialSort = params.sort === "popular" ? "popular" : "latest";

  return (
    <MarketplaceApp
      route="marketplace"
      initialProfiles={snapshot.profiles}
      initialListings={snapshot.listings}
      initialQuery={typeof params.q === "string" ? params.q.slice(0, 120) : ""}
      initialChannel={
        typeof params.channel === "string" ? params.channel.slice(0, 80) : "All"
      }
      initialRoleFilter={requestedRole as
        | "all"
        | "supply"
        | "business"
        | "creator"}
      initialSort={initialSort}
    />
  );
}
