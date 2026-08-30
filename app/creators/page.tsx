import type { Metadata } from "next";
import PublicSiteApp from "../components/PublicSiteApp";
import { loadMarketplaceSnapshot } from "@/lib/public-marketplace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { canonical: "/creators" },
  title: "Creators and local advertising inventory",
  description:
    "List social audiences, physical placements, newsletters, teams, events, and other local advertising inventory on SideSpace.",
  openGraph: {
    url: "/creators",
    title: "Creators and local advertising inventory on SideSpace",
    description:
      "Define your offer, set your price, and talk directly with local businesses.",
  },
};

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
