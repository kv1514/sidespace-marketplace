import type { Metadata } from "next";
import PublicSiteApp from "../components/PublicSiteApp";

export const metadata: Metadata = {
  alternates: { canonical: "/pricing" },
  title: "Pricing",
  description:
    "List and browse without a subscription. Paid SideSpace campaigns use a clear 5% business fee and 5% creator fee.",
  openGraph: {
    url: "/pricing",
    title: "SideSpace pricing - 5% + 5% marketplace fees",
    description:
      "Businesses pay the campaign price plus 5%; creators receive the campaign price minus 5%. Applicable tax is calculated at checkout.",
  },
};

export default function Pricing() {
  return <PublicSiteApp route="pricing" />;
}
