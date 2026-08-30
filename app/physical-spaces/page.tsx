import type { Metadata } from "next";
import PublicSiteApp from "../components/PublicSiteApp";
import { loadMarketplaceSnapshot } from "@/lib/public-marketplace";
import { OG_IMAGE } from "@/lib/site-metadata";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { canonical: "/physical-spaces" },
  title: "Physical advertising spaces",
  description:
    "Turn storefront windows, counters, vehicles, walls, boards, land, and venues into bookable local advertising space.",
  openGraph: {
    images: OG_IMAGE,
    url: "/physical-spaces",
    title: "Physical spaces on SideSpace",
    description:
      "Ordinary local space can become precise, owner-controlled advertising inventory.",
  },
};

export default async function PhysicalSpaces() {
  const snapshot = await loadMarketplaceSnapshot({
    profileLimit: 18,
    listingLimit: 24,
    label: "physical-spaces",
  });
  return (
    <PublicSiteApp
      route="physical-spaces"
      initialListings={snapshot.listings}
    />
  );
}
