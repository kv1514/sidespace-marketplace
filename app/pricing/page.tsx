import type { Metadata } from "next";
import PublicSiteApp from "../components/PublicSiteApp";
import { OG_IMAGE } from "@/lib/site-metadata";
import { getTranslator } from "@/lib/i18n-server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return {
  alternates: { canonical: "/pricing" },
  title: t("meta.pricingTitle"),
  description: t("meta.pricingDescription"),
  openGraph: {
    images: OG_IMAGE,
    url: "/pricing",
    title: t("meta.pricingOgTitle"),
    description: t("meta.pricingOgDescription"),
  },
  };
}

export default function Pricing() {
  return <PublicSiteApp route="pricing" />;
}
