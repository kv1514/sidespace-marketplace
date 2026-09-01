import { calculatePaymentBreakdown } from "./fees";

export type CampaignPaymentSource = {
  id: string;
  campaign_name: string;
  status: string;
  accepted_subtotal_cents: number | null;
  requester_profile_id: string;
  owner_profile_id: string;
  payer_profile_id: string | null;
  payee_profile_id: string | null;
  listing: {
    id: string;
    owner_profile_id: string;
    title: string;
    channel: string;
  };
  requester: {
    id: string;
    display_name: string;
    role?: string | null;
    extra_roles?: string[] | null;
  };
  owner: {
    id: string;
    display_name: string;
    role?: string | null;
    extra_roles?: string[] | null;
  };
};

export function isBusinessBrief(channel: string) {
  return channel.trim().toLowerCase() === "business brief";
}

export function deriveMarketplaceParties(campaign: CampaignPaymentSource) {
  if (campaign.listing.owner_profile_id !== campaign.owner_profile_id) {
    throw new Error("The campaign listing owner no longer matches the request.");
  }

  if (!campaign.payer_profile_id || !campaign.payee_profile_id) {
    throw new Error("Accepted campaign payment parties are missing.");
  }

  const participantIds = new Set([
    campaign.requester_profile_id,
    campaign.owner_profile_id,
  ]);
  if (
    !participantIds.has(campaign.payer_profile_id) ||
    !participantIds.has(campaign.payee_profile_id) ||
    campaign.payer_profile_id === campaign.payee_profile_id
  ) {
    throw new Error("Accepted campaign payment parties are invalid.");
  }

  const participants = new Map<string, { id: string; display_name: string }>([
    [campaign.requester.id, campaign.requester],
    [campaign.owner.id, campaign.owner],
  ]);
  const business = participants.get(campaign.payer_profile_id);
  const creator = participants.get(campaign.payee_profile_id);
  if (!business || !creator) {
    throw new Error("Accepted campaign payment parties no longer match the request.");
  }

  return { business, creator };
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
