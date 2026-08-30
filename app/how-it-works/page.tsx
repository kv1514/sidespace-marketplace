import type { Metadata } from "next";
import PublicSiteApp from "../components/PublicSiteApp";
import { OG_IMAGE } from "@/lib/site-metadata";

export const metadata: Metadata = {
  alternates: { canonical: "/how-it-works" },
  title: "How it works",
  description:
    "See how advertisers discover local attention and how creators, owners, and hosts list, negotiate, and accept campaigns on SideSpace.",
  openGraph: {
    images: OG_IMAGE,
    url: "/how-it-works",
    title: "How SideSpace works",
    description:
      "Discover, request, message, negotiate, agree, and run a local campaign directly.",
  },
};

export default function HowItWorks() {
  return <PublicSiteApp route="how-it-works" />;
}
