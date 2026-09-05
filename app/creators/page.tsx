import type { Metadata } from "next";
import PublicSiteApp from "../components/PublicSiteApp";
import { loadMarketplaceSnapshot } from "@/lib/public-marketplace";
import { OG_IMAGE } from "@/lib/site-metadata";
import { getTranslator } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return {
  alternates: { canonical: "/creators" },
  title: t("meta.creatorsTitle"),
  description: t("meta.creatorsDescription"),
  openGraph: {
    images: OG_IMAGE,
    url: "/creators",
    title: t("meta.creatorsOgTitle"),
    description: t("meta.creatorsOgDescription"),
  },
  };
}

export default async function Creators() {
  const snapshot = await loadMarketplaceSnapshot({
    profileLimit: 18,
    listingLimit: 24,
    label: "creators",
  });
  return (
    <PublicSiteApp
      route="creators"
      initialListings={snapshot.listings}
    />
  );
}
