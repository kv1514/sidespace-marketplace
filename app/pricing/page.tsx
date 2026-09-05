import type { Metadata } from "next";
import PublicSiteApp from "../components/PublicSiteApp";
import { OG_IMAGE } from "@/lib/site-metadata";
import { getTranslator } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return {
    alternates: { canonical: "/pricing" },
    title: t("Pricing"),
    description: t(
      "List and browse without a subscription. Paid SideSpace campaigns use a clear 5% business fee and 5% creator fee.",
    ),
    openGraph: {
      images: OG_IMAGE,
      url: "/pricing",
      title: t("SideSpace pricing - 5% + 5% marketplace fees"),
      description: t(
        "Businesses pay the campaign price plus 5%; creators receive the campaign price minus 5%. Applicable tax is calculated at checkout.",
      ),
    },
  };
}

export default function Pricing() {
  return <PublicSiteApp route="pricing" />;
}
