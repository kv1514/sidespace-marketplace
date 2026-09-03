import type { Metadata } from "next";
import MarketplaceApp from "../MarketplaceApp";
import {
  isBusinessReferralCode,
  normalizeBusinessReferralCode,
} from "@/lib/payments/ad-credits";
import { loadInvite, loadReferralCredit } from "@/lib/public-marketplace";

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
  const referralParam = typeof params.ref === "string" ? params.ref : "";
  const referralCode = isBusinessReferralCode(referralParam)
    ? normalizeBusinessReferralCode(referralParam)
    : "";
  const openProfile = params.profile === "1";
  const [invite, referralCreditCents] = await Promise.all([
    loadInvite(params.p),
    loadReferralCredit(referralCode),
  ]);
  return (
    <MarketplaceApp
      route="dashboard"
      invite={invite}
      referralCode={referralCode}
      referralCreditCents={referralCreditCents}
      openProfile={openProfile}
    />
  );
}
