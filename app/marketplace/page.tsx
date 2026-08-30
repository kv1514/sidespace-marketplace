import type { Metadata } from "next";
import MarketplaceApp from "../MarketplaceApp";
import { loadMarketplaceSnapshot } from "@/lib/public-marketplace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { canonical: "/marketplace" },
  title: "Marketplace",
  description:
    "Browse creator listings for social audiences, physical placements, sponsorships, and business campaign briefs on SideSpace.",
  openGraph: {
    url: "/marketplace",
    title: "Browse the SideSpace marketplace",
    description:
    "Search real local attention from creators: storefronts, vehicles, sponsorships, and more.",
  },
};

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
    />
  );
}
