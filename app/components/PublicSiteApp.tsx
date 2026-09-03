"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import {
  localListingSeeds,
  localProfiles,
} from "@/app/localMarketplaceData";
import {
  CreatorsPage,
  HowItWorksPage,
  LandingPage,
  PricingPage,
  type PublicListing,
} from "@/app/components/PublicPages";
import {
  SiteFooter,
  SiteHeader,
  type SideSpaceRoute,
} from "@/app/components/SiteChrome";
import SmoothScroll from "@/app/components/SmoothScroll";
import ScrollParallax from "@/app/components/ScrollParallax";

type PublicRoute = Exclude<SideSpaceRoute, "marketplace" | "dashboard">;

type Viewer = {
  displayName: string;
  avatarUrl?: string;
};

function safeListings(value: unknown): PublicListing[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PublicListing => {
    if (!item || typeof item !== "object") return false;
    const listing = item as Partial<PublicListing>;
    return Boolean(
      typeof listing.id === "string" &&
        typeof listing.title === "string" &&
        typeof listing.channel === "string" &&
        listing.owner &&
        typeof listing.owner.id === "string" &&
        typeof listing.owner.display_name === "string",
    );
  });
}

export default function PublicSiteApp({
  route,
  initialListings = null,
  inviteToken = "",
  referralCode = "",
}: {
  route: PublicRoute;
  initialListings?: unknown;
  inviteToken?: string;
  referralCode?: string;
}) {
  const router = useRouter();
  const configured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
  const [loadingViewer, setLoadingViewer] = useState(configured);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const listings = useMemo(() => {
    const loaded = safeListings(initialListings);
    const fallback = safeListings(
      localListingSeeds.map((listing) => ({
        ...listing,
        owner: localProfiles.find(
          (profile) => profile.id === listing.owner_profile_id,
        ),
      })),
    );
    // Briefs last, then samples last within what is left. A "Business brief"
    // is a business asking for space rather than space to book, so it reads
    // oddly as the first card in a list of inventory. It stays in the
    // marketplace, at the end, rather than being dropped.
    //
    // The cap is the same on every route now. It was 8 on home, which is fewer
    // rows than the home page actually presents - a hero offering four kinds
    // of inventory plus a physical and an audience section - so a kind that
    // was not among the eight newest listings had nothing to show at all.
    return (loaded.length ? loaded : fallback)
      .sort(
        (left, right) =>
          Number(left.channel === "Business brief") -
            Number(right.channel === "Business brief") ||
          Number(left.owner.is_demo) - Number(right.owner.is_demo),
      )
      .slice(0, 24);
  }, [initialListings]);

  // Public pages only need enough account state to render the right header.
  // Load the Supabase browser client after hydration so the initial marketing
  // bundle stays independent from the full marketplace/auth engine.
  useEffect(() => {
    if (!configured) return;
    let mounted = true;
    let unsubscribe = () => {};

    void import("@/lib/supabase/client")
      .then(async ({ createClient }) => {
        if (!mounted) return;
        const supabase = createClient();

        async function resolveViewer(user?: User | null) {
          if (!mounted) return;
          if (!user) {
            setViewer(null);
            setLoadingViewer(false);
            return;
          }
          const { data } = await supabase
            .from("my_profiles")
            .select("display_name, avatar_url")
            .eq("auth_user_id", user.id)
            .maybeSingle();
          if (!mounted) return;
          const metadata = user.user_metadata as Record<string, unknown>;
          setViewer({
            displayName: String(
              data?.display_name ||
                metadata.full_name ||
                user.email?.split("@")[0] ||
                "Your account",
            ),
            avatarUrl: String(
              data?.avatar_url || metadata.avatar_url || "",
            ) || undefined,
          });
          setLoadingViewer(false);
        }

        const { data } = await supabase.auth.getUser();
        await resolveViewer(data.user);
        if (!mounted) return;
        const { data: authListener } = supabase.auth.onAuthStateChange(
          (_event: AuthChangeEvent, session: Session | null) => {
            void resolveViewer(session?.user);
          },
        );
        unsubscribe = () => authListener.subscription.unsubscribe();
      })
      .catch(() => {
        if (mounted) setLoadingViewer(false);
      });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [configured]);

  function openAuth(mode: "signin" | "signup") {
    const query = new URLSearchParams();
    if (inviteToken) query.set("p", inviteToken);
    if (referralCode) query.set("ref", referralCode);
    const preserved = query.toString();
    router.push(`/dashboard?auth=${mode}${preserved ? `&${preserved}` : ""}`);
  }

  function openListing(listingId: string) {
    router.push(`/marketplace?listing=${encodeURIComponent(listingId)}`);
  }

  function listAttention() {
    if (viewer) {
      router.push("/dashboard");
      return;
    }
    openAuth("signup");
  }

  return (
    <main>
      <SmoothScroll />
      <ScrollParallax key={route} />
      <a className="ss-skip-link" href="#main-content">
        Skip to main content
      </a>
      <SiteHeader
        route={route}
        loading={loadingViewer}
        viewer={viewer}
        unreadCount={0}
        onMessages={() => router.push("/dashboard")}
        onSignIn={() => openAuth("signin")}
        onJoin={() => openAuth("signup")}
        onAccount={() => router.push("/dashboard?profile=1")}
      />

      {route === "home" && (
        <LandingPage
          listings={listings}
          onJoin={() => openAuth("signup")}
          onList={listAttention}
        />
      )}
      {route === "how-it-works" && (
        <HowItWorksPage onJoin={() => openAuth("signup")} />
      )}
      {route === "creators" && (
        <CreatorsPage
          listings={listings}
          onList={listAttention}
          onOpenListing={openListing}
        />
      )}
      {route === "pricing" && (
        <PricingPage onJoin={() => openAuth("signup")} />
      )}

      <SiteFooter onJoin={listAttention} />
    </main>
  );
}
