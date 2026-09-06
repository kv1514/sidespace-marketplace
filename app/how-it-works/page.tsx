import type { Metadata } from "next";
import PublicSiteApp from "../components/PublicSiteApp";
import { OG_IMAGE } from "@/lib/site-metadata";
import { getTranslator } from "@/lib/i18n-server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return {
  alternates: { canonical: "/how-it-works" },
  title: t("meta.howItWorksTitle"),
  description: t("meta.howItWorksDescription"),
  openGraph: {
    images: OG_IMAGE,
    url: "/how-it-works",
    title: t("meta.howItWorksOgTitle"),
    description: t("meta.howItWorksOgDescription"),
  },
  };
}

export default function HowItWorks() {
  return <PublicSiteApp route="how-it-works" />;
}
