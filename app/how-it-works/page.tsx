import type { Metadata } from "next";
import PublicSiteApp from "../components/PublicSiteApp";
import { OG_IMAGE } from "@/lib/site-metadata";
import { getTranslator } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return {
    alternates: { canonical: "/how-it-works" },
    title: t("How it works"),
    description: t(
      "See how advertisers discover local attention and how creators list social, physical, and sponsorship inventory on SideSpace.",
    ),
    openGraph: {
      images: OG_IMAGE,
      url: "/how-it-works",
      title: t("How SideSpace works"),
      description: t(
        "Discover, request, message, negotiate, agree, and run a local campaign directly.",
      ),
    },
  };
}

export default function HowItWorks() {
  return <PublicSiteApp route="how-it-works" />;
}
