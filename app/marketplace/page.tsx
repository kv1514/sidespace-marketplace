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
import { getTranslator } from "@/lib/i18n-server";
import type { Translate } from "@/lib/i18n";

export const dynamic = "force-dynamic";

function marketplaceMetadata(t: Translate): Metadata {
  return {
    alternates: { canonical: "/marketplace" },
    title: t("chrome.marketplace"),
    description: t("meta.marketplaceDescription"),
    openGraph: {
      images: OG_IMAGE,
      url: "/marketplace",
      title: t("meta.marketplaceOgTitle"),
      description: t("meta.marketplaceOgDescription"),
    },
    twitter: {
      card: "summary_large_image",
      images: OG_IMAGE,
      title: t("meta.marketplaceOgTitle"),
      description: t("meta.marketplaceOgDescription"),
    },
  };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const params = await searchParams;
  const { t } = await getTranslator();
  const base = marketplaceMetadata(t);
  const listingId = typeof params.listing === "string" ? params.listing : "";
  if (!listingId && params.sort === "popular") {
    return {
      ...base,
      alternates: { canonical: "/marketplace?sort=popular" },
      title: t("meta.popularTitle"),
      description: t("meta.popularDescription"),
      openGraph: {
        ...base.openGraph,
        url: "/marketplace?sort=popular",
        title: t("meta.popularOgTitle"),
        description: t("meta.popularDescription"),
      },
      twitter: {
        ...base.twitter,
        title: t("meta.popularOgTitle"),
        description: t("meta.popularDescription"),
      },
    };
  }
  if (!listingId) return base;

  const listing = await loadPublicListing(listingId);
  return listing
    ? createListingSocialMetadata(listing)
    : base;
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
  const initialSort =
    params.sort === "popular" || params.sort === "location"
      ? params.sort
      : "latest";

  return (
    <MarketplaceApp
      route="marketplace"
      initialProfiles={snapshot.profiles}
      initialListings={snapshot.listings}
      initialQuery={typeof params.q === "string" ? params.q.slice(0, 120) : ""}
      initialLocation={
        typeof params.location === "string"
          ? params.location.slice(0, 120)
          : ""
      }
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
