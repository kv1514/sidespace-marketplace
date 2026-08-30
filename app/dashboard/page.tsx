import type { Metadata } from "next";
import MarketplaceApp from "../MarketplaceApp";
import { loadInvite } from "@/lib/public-marketplace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { canonical: "/dashboard" },
  title: "Dashboard",
  description: "Manage your SideSpace profile, listings, requests, and messages.",
  robots: { index: false, follow: false },
};

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const invite = await loadInvite(params.p);
  return <MarketplaceApp route="dashboard" invite={invite} />;
}
