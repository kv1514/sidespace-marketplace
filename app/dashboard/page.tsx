import type { Metadata } from "next";
import MarketplaceApp from "../MarketplaceApp";
import {
  isBusinessReferralCode,
  normalizeBusinessReferralCode,
} from "@/lib/payments/ad-credits";
import { loadInvite } from "@/lib/public-marketplace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { canonical: "/dashboard" },
  title: "Dashboard",
  description: "Manage your SideSpace profile, listings, requests, and messages.",
  robots: { index: false, follow: false },
};

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const invite = await loadInvite(params.p);
  const referralParam = typeof params.ref === "string" ? params.ref : "";
  const referralCode = isBusinessReferralCode(referralParam)
    ? normalizeBusinessReferralCode(referralParam)
    : "";
  return (
    <MarketplaceApp
      route="dashboard"
      invite={invite}
      referralCode={referralCode}
    />
  );
}
