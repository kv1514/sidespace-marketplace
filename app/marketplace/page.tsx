import type { Metadata } from "next";
import MarketplaceApp from "../MarketplaceApp";
import { loadMarketplaceSnapshot } from "@/lib/public-marketplace";
import { OG_IMAGE } from "@/lib/site-metadata";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { canonical: "/marketplace" },
  title: "Marketplace",
  description:
    "Browse local creators, physical ad space, newsletters, sponsorships, and business campaign briefs on SideSpace.",
  openGraph: {
    images: OG_IMAGE,
    url: "/marketplace",
    title: "Browse the SideSpace marketplace",
    description:
      "Search real local attention: creators, storefronts, vehicles, sponsorships, and more.",
  },
};

const ROLE_FILTERS = new Set([
  "all",
  "supply",
  "business",
  "creator",
  "space_owner",
  "sponsor_host",
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
        : typeof params.role === "string" && ROLE_FILTERS.has(params.role)
          ? params.role
          : "all";

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
        | "creator"
        | "space_owner"
        | "sponsor_host"}
    />
  );
}
