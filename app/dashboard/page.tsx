import type { Metadata } from "next";
import MarketplaceApp from "../MarketplaceApp";
import {
  isBusinessReferralCode,
  normalizeBusinessReferralCode,
} from "@/lib/payments/ad-credits";
import { loadInvite, loadReferralCredit } from "@/lib/public-marketplace";
import { getTranslator } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return {
    alternates: { canonical: "/dashboard" },
    title: t("chrome.dashboard"),
    description: t("meta.dashboardDescription"),
    robots: { index: false, follow: false },
  };
}

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
  const openOnboarding = params.onboarding === "1";
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
      openOnboarding={openOnboarding}
    />
  );
}
