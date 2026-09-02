import type { Metadata } from "next";
import { isBusinessReferralCode, normalizeBusinessReferralCode } from "@/lib/payments/ad-credits";
import PublicSiteApp from "./components/PublicSiteApp";
import InviteMarketplaceBridge from "./components/InviteMarketplaceBridge";
import { OG_IMAGE } from "@/lib/site-metadata";
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
    images: OG_IMAGE,
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
  const referralParam = typeof params.ref === "string" ? params.ref : "";
  const referralCode = isBusinessReferralCode(referralParam)
    ? normalizeBusinessReferralCode(referralParam)
    : "";
  const [invite, snapshot] = await Promise.all([
    loadInvite(inviteToken),
    // The homepage proves the marketplace is real with a small preview. It no
    // longer pays for the complete browser it does not render.
    loadMarketplaceSnapshot({
      profileLimit: 8,
      // The hero introduces four kinds of inventory and the two sections
      // below it show physical and audience examples, so eight rows was
      // never enough to fill the page from: whichever kind happened not to
      // be in the eight newest listings had nothing to show.
      listingLimit: 24,
      label: "home",
    }),
  ]);

  // Referral and prospect links keep the full onboarding engine mounted even
  // when the lookup is temporarily unavailable. Normal homepage visits use
  // the much smaller public shell and load listing details on /marketplace.
  if (!isInviteToken(inviteToken) && !referralCode) {
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
      referralCode={referralCode}
    />
  );
}
