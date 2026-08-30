import type { Metadata } from "next";
import PublicSiteApp from "../components/PublicSiteApp";

export const metadata: Metadata = {
  alternates: { canonical: "/how-it-works" },
  title: "How it works",
  description:
    "See how advertisers discover local attention and how creators list social, physical, and sponsorship inventory on SideSpace.",
  openGraph: {
    url: "/how-it-works",
    title: "How SideSpace works",
    description:
      "Discover, request, message, negotiate, agree, and run a local campaign directly.",
  },
};

export default function HowItWorks() {
  return <PublicSiteApp route="how-it-works" />;
}
