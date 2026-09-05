import type { Metadata } from "next";
import PublicSiteApp from "../components/PublicSiteApp";
import { loadMarketplaceSnapshot } from "@/lib/public-marketplace";
import { OG_IMAGE } from "@/lib/site-metadata";
import { getTranslator } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return {
    alternates: { canonical: "/creators" },
    title: t("Creators and local advertising inventory"),
    description: t(
      "List social audiences, physical placements, newsletters, teams, events, and other local advertising inventory on SideSpace.",
    ),
    openGraph: {
      images: OG_IMAGE,
      url: "/creators",
      title: t("Creators and local advertising inventory on SideSpace"),
      description: t(
        "Define your offer, set your price, and talk directly with local businesses.",
      ),
    },
  };
}

export default async function Creators() {
  const snapshot = await loadMarketplaceSnapshot({
    profileLimit: 18,
    listingLimit: 24,
    label: "creators",
  });
  return (
    <PublicSiteApp
      route="creators"
      initialListings={snapshot.listings}
    />
  );
}
