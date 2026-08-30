import type { Metadata } from "next";
import PublicSiteApp from "../components/PublicSiteApp";
import { loadMarketplaceSnapshot } from "@/lib/public-marketplace";
import { OG_IMAGE } from "@/lib/site-metadata";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { canonical: "/creators" },
  title: "Creators, audiences, and sponsorships",
  description:
    "List Instagram, TikTok, YouTube, newsletters, teams, events, and other local audience opportunities on SideSpace.",
  openGraph: {
    images: OG_IMAGE,
    url: "/creators",
    title: "Creators and audience owners on SideSpace",
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
