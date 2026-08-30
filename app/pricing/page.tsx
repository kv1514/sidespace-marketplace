import type { Metadata } from "next";
import PublicSiteApp from "../components/PublicSiteApp";
import { OG_IMAGE } from "@/lib/site-metadata";

export const metadata: Metadata = {
  alternates: { canonical: "/pricing" },
  title: "Pricing",
  description:
    "SideSpace is free during early access. Planned future pricing is clearly separated from what is live today.",
  openGraph: {
    images: OG_IMAGE,
    url: "/pricing",
    title: "SideSpace pricing - free during early access",
    description:
      "No platform fee is charged today. Future paid features are not active plans.",
  },
};

export default function Pricing() {
  return <PublicSiteApp route="pricing" />;
}
