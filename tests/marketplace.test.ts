import { describe, expect, it } from "vitest";

import {
  createTrustedPaymentSnapshot,
  deriveMarketplaceParties,
  type CampaignPaymentSource,
} from "../lib/payments/marketplace";

function campaign(
  overrides: Partial<CampaignPaymentSource> = {},
): CampaignPaymentSource {
  return {
    id: "campaign-1",
    campaign_name: "Launch week",
    status: "accepted",
    accepted_subtotal_cents: 10_000,
    requester_profile_id: "business-1",
    owner_profile_id: "creator-1",
    listing: {
      id: "listing-1",
      owner_profile_id: "creator-1",
      title: "Three local stories",
      channel: "Instagram",
    },
    requester: { id: "business-1", display_name: "Brea Bakery" },
    owner: { id: "creator-1", display_name: "Maya" },
    ...overrides,
  };
}

describe("trusted marketplace party derivation", () => {
  it("makes the requester pay a normal supply listing", () => {
    expect(deriveMarketplaceParties(campaign())).toEqual({
      business: { id: "business-1", display_name: "Brea Bakery" },
      creator: { id: "creator-1", display_name: "Maya" },
    });
  });

  it("reverses payer and payee for a business brief", () => {
    const brief = campaign({
      requester_profile_id: "creator-1",
      owner_profile_id: "business-1",
      listing: {
        id: "listing-1",
        owner_profile_id: "business-1",
        title: "Need a neighborhood window",
        channel: "Business brief",
      },
      requester: { id: "creator-1", display_name: "Maya" },
      owner: { id: "business-1", display_name: "Brea Bakery" },
    });
    expect(deriveMarketplaceParties(brief)).toEqual({
      business: { id: "business-1", display_name: "Brea Bakery" },
      creator: { id: "creator-1", display_name: "Maya" },
    });
  });

  it("builds the $100 snapshot from server-loaded accepted terms", () => {
    expect(createTrustedPaymentSnapshot(campaign())).toMatchObject({
      campaignRequestId: "campaign-1",
      businessProfileId: "business-1",
      creatorProfileId: "creator-1",
      subtotalCents: 10_000,
      buyerFeeCents: 500,
      creatorFeeCents: 500,
      customerTotalCents: 10_500,
      creatorPayoutCents: 9_500,
      platformGrossRevenueCents: 1_000,
    });
  });

  it("rejects unpaid terms and mismatched listing ownership", () => {
    expect(() =>
      createTrustedPaymentSnapshot(campaign({ status: "pending" })),
    ).toThrow(/accepted/);
    expect(() =>
      deriveMarketplaceParties(
        campaign({
          listing: {
            id: "listing-1",
            owner_profile_id: "someone-else",
            title: "Tampered",
            channel: "Instagram",
          },
        }),
      ),
    ).toThrow(/owner no longer matches/);
  });
});
