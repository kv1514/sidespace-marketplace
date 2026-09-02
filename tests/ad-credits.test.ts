import { describe, expect, it } from "vitest";

import {
  applyAdCreditToCheckout,
  BUSINESS_REFERRAL_CODE,
  BUSINESS_SIGNUP_CREDIT_CENTS,
  isBusinessReferralCode,
  maximumAdCreditCents,
  MINIMUM_STRIPE_CHARGE_CENTS,
  normalizeBusinessReferralCode,
} from "../lib/payments/ad-credits";

describe("business ad credits", () => {
  it("accepts safe shared and founder-created referral codes case-insensitively", () => {
    expect(normalizeBusinessReferralCode(" sidespace5 ")).toBe(
      BUSINESS_REFERRAL_CODE,
    );
    expect(isBusinessReferralCode("sidespace5")).toBe(true);
    expect(isBusinessReferralCode("ss-2abcde9xyz")).toBe(true);
    expect(isBusinessReferralCode("tiny")).toBe(false);
    expect(isBusinessReferralCode("bad code<script>")).toBe(false);
  });

  it("applies the $5 promotion to the campaign before the buyer fee", () => {
    expect(
      applyAdCreditToCheckout({
        subtotalCents: 10_000,
        buyerFeeCents: 500,
        availableCents: BUSINESS_SIGNUP_CREDIT_CENTS,
      }),
    ).toEqual({
      customerTotalCents: 10_500,
      adCreditCents: 500,
      chargedCampaignCents: 9_500,
      chargedBuyerFeeCents: 500,
      chargedTotalCents: 10_000,
    });
  });

  it("leaves the Creator economics unchanged", () => {
    const result = applyAdCreditToCheckout({
      subtotalCents: 10_000,
      buyerFeeCents: 500,
      availableCents: BUSINESS_SIGNUP_CREDIT_CENTS,
    });

    expect(result.customerTotalCents).toBe(10_500);
    expect(result.chargedTotalCents).toBe(10_000);
    expect(result.adCreditCents).toBe(500);
  });

  it("keeps a minimum Stripe charge for a small campaign", () => {
    const result = applyAdCreditToCheckout({
      subtotalCents: 200,
      buyerFeeCents: 10,
      availableCents: BUSINESS_SIGNUP_CREDIT_CENTS,
    });

    expect(result.adCreditCents).toBe(160);
    expect(result.chargedTotalCents).toBe(MINIMUM_STRIPE_CHARGE_CENTS);
    expect(result.chargedCampaignCents).toBe(40);
    expect(result.chargedBuyerFeeCents).toBe(10);
  });

  it("uses leftover credit on the buyer fee only after the subtotal is covered", () => {
    expect(
      applyAdCreditToCheckout({
        subtotalCents: 300,
        buyerFeeCents: 15,
        availableCents: 100,
      }),
    ).toMatchObject({
      adCreditCents: 100,
      chargedCampaignCents: 200,
      chargedBuyerFeeCents: 15,
      chargedTotalCents: 215,
    });
  });

  it("caps the usable balance at the minimum-charge boundary", () => {
    expect(maximumAdCreditCents(10_500)).toBe(10_450);
    expect(maximumAdCreditCents(40)).toBe(0);
    expect(maximumAdCreditCents(105, 95)).toBe(10);
  });

  it("does not reduce a source charge below the Creator payout", () => {
    const result = applyAdCreditToCheckout({
      subtotalCents: 100,
      buyerFeeCents: 5,
      availableCents: BUSINESS_SIGNUP_CREDIT_CENTS,
      minimumChargedCents: 95,
    });

    expect(result.adCreditCents).toBe(10);
    expect(result.chargedTotalCents).toBe(95);
  });
});
