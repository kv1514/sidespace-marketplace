import type { Metadata } from "next";
import PublicSiteApp from "./components/PublicSiteApp";
import InviteMarketplaceBridge from "./components/InviteMarketplaceBridge";
import {
  isInviteToken,
  loadInvite,
  loadMarketplaceSnapshot,
} from "@/lib/public-marketplace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  title: "SideSpace - Local attention, now bookable",
  description:
    "Book creators offering social, physical, and sponsorship inventory—or list the way you can advertise.",
  openGraph: {
    url: "/",
    title: "SideSpace - Local attention, now bookable",
    description:
      "The marketplace for creators with social audiences, physical placements, sponsorships, and more.",
  },
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const inviteToken = typeof params.p === "string" ? params.p : "";
  const [invite, snapshot] = await Promise.all([
    loadInvite(inviteToken),
    // The homepage proves the marketplace is real with a small preview. It no
    // longer pays for the complete browser it does not render.
    loadMarketplaceSnapshot({
      profileLimit: 8,
      listingLimit: 8,
      label: "home",
    }),
  ]);

  // Prospect links keep the full onboarding engine mounted even when the
  // lookup is temporarily unavailable. Normal homepage visits use the much
  // smaller public shell and load listing details on /marketplace.
  if (!isInviteToken(inviteToken)) {
    return (
      <PublicSiteApp route="home" initialListings={snapshot.listings} />
    );
  }

  return (
    <InviteMarketplaceBridge
      route="home"
      initialProfiles={snapshot.profiles}
      initialListings={snapshot.listings}
      invite={invite}
      inviteToken={inviteToken}
    />
  );
}
