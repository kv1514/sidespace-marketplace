"use client";

import { useEffect, useState, type ComponentType } from "react";
import type { Invite } from "@/lib/supabase/public";
import PublicSiteApp from "@/app/components/PublicSiteApp";

type InviteEngineProps = {
  route: "home";
  initialProfiles: unknown;
  initialListings: unknown;
  invite: Invite | null;
};

type InviteBridgeProps = InviteEngineProps & { inviteToken: string };

// Outreach traffic is a tiny fraction of homepage traffic, but it needs the
// complete onboarding engine. A raw import inside the mounted bridge keeps
// that engine out of every ordinary `/` response while retaining `/?p=<uuid>`
// as the public URL prospects already receive.
export default function InviteMarketplaceBridge(
  props: InviteBridgeProps,
) {
  const [InviteEngine, setInviteEngine] = useState<
    ComponentType<InviteEngineProps> | null
  >(null);

  useEffect(() => {
    let mounted = true;
    void import("@/app/MarketplaceApp").then(({ default: MarketplaceApp }) => {
      if (mounted) setInviteEngine(() => MarketplaceApp);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (!InviteEngine) {
    return (
      <PublicSiteApp
        route="home"
        initialListings={props.initialListings}
        inviteToken={props.inviteToken}
      />
    );
  }

  return (
    <InviteEngine
      route={props.route}
      initialProfiles={props.initialProfiles}
      initialListings={props.initialListings}
      invite={props.invite}
    />
  );
}
