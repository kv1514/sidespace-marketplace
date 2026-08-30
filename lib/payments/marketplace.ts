import { calculatePaymentBreakdown } from "./fees";

export type CampaignPaymentSource = {
  id: string;
  campaign_name: string;
  status: string;
  accepted_subtotal_cents: number | null;
  requester_profile_id: string;
  owner_profile_id: string;
  listing: {
    id: string;
    owner_profile_id: string;
    title: string;
    channel: string;
  };
  requester: { id: string; display_name: string };
  owner: { id: string; display_name: string };
};

export function isBusinessBrief(channel: string) {
  return channel.trim().toLowerCase() === "business brief";
}

export function deriveMarketplaceParties(campaign: CampaignPaymentSource) {
  if (campaign.listing.owner_profile_id !== campaign.owner_profile_id) {
    throw new Error("The campaign listing owner no longer matches the request.");
  }

  if (isBusinessBrief(campaign.listing.channel)) {
    return {
      business: campaign.owner,
      creator: campaign.requester,
    };
  }

  return {
    business: campaign.requester,
    creator: campaign.owner,
  };
}

export function createTrustedPaymentSnapshot(campaign: CampaignPaymentSource) {
  if (campaign.status !== "accepted") {
    throw new Error("Campaign terms must be accepted before checkout.");
  }
  if (!campaign.accepted_subtotal_cents) {
    throw new Error("The accepted campaign amount is missing.");
  }
  const parties = deriveMarketplaceParties(campaign);
  const money = calculatePaymentBreakdown(campaign.accepted_subtotal_cents);

  return {
    campaignRequestId: campaign.id,
    listingId: campaign.listing.id,
    campaignName: campaign.campaign_name,
    listingTitle: campaign.listing.title,
    businessProfileId: parties.business.id,
    businessName: parties.business.display_name,
    creatorProfileId: parties.creator.id,
    creatorName: parties.creator.display_name,
    ...money,
  };
}
