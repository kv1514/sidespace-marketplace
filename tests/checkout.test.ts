import { describe, expect, it } from "vitest";

import { buildCheckoutSessionParams } from "../lib/payments/checkout";

describe("hosted Checkout platform charge with delayed transfer", () => {
  const params = buildCheckoutSessionParams(
    {
      transactionId: "transaction-1",
      campaignRequestId: "campaign-1",
      campaignName: "Launch week",
      listingTitle: "Three local stories",
      creatorProfileId: "creator-1",
      customerId: "cus_test_business",
      subtotalCents: 10_000,
      buyerFeeCents: 500,
      creatorFeeCents: 500,
      customerTotalCents: 10_500,
      creatorPayoutCents: 9_500,
      platformGrossRevenueCents: 1_000,
    },
    "http://localhost:3000",
  );

  it("charges $105 before tax and leaves the creator $95", () => {
    expect(params.line_items?.map((item) => item.price_data?.unit_amount)).toEqual([
      10_000,
      500,
    ]);
    expect(params.payment_intent_data).toMatchObject({
      transfer_group: "sidespace_campaign_transaction-1",
    });
    expect(params.payment_intent_data).not.toHaveProperty("application_fee_amount");
    expect(params.payment_intent_data).not.toHaveProperty("transfer_data");
  });

  it("uses platform tax liability, invoice creation, and card-only payments", () => {
    expect(params.automatic_tax).toEqual({
      enabled: true,
      liability: { type: "self" },
    });
    expect(params.invoice_creation?.enabled).toBe(true);
    expect(params.payment_method_types).toEqual(["card"]);
    expect(params.payment_intent_data).not.toHaveProperty("on_behalf_of");
  });

  it("carries only trusted record identifiers in metadata", () => {
    expect(params.metadata).toMatchObject({
      sidespace_transaction_id: "transaction-1",
      sidespace_campaign_request_id: "campaign-1",
      sidespace_ad_credit_cents: "0",
    });
    expect(params.metadata).not.toHaveProperty("amount");
    expect(params.metadata).not.toHaveProperty("connected_account");
  });

  it("passes the reserved advertising credit through to Stripe's charged line items", () => {
    const credited = buildCheckoutSessionParams(
      {
        transactionId: "transaction-2",
        campaignRequestId: "campaign-2",
        campaignName: "Launch week",
        listingTitle: "Three local stories",
        creatorProfileId: "creator-1",
        customerId: "cus_test_business",
        subtotalCents: 10_000,
        buyerFeeCents: 500,
        creatorFeeCents: 500,
        customerTotalCents: 10_500,
        creatorPayoutCents: 9_500,
        platformGrossRevenueCents: 1_000,
        adCreditCents: 500,
        chargedCampaignCents: 9_500,
        chargedBuyerFeeCents: 500,
        chargedTotalCents: 10_000,
      },
      "http://localhost:3000",
    );

    expect(credited.line_items?.map((item) => item.price_data?.unit_amount)).toEqual([
      9_500,
      500,
    ]);
    expect(credited.metadata?.sidespace_ad_credit_cents).toBe("500");
  });
});
