/**
 * SideSpace ad credits are a platform-funded promotion for Business buyers.
 * They reduce what the buyer pays at Checkout; they never change the Creator's
 * agreed campaign amount or payout.
 */
export const BUSINESS_SIGNUP_CREDIT_CENTS = 500;
export const BUSINESS_REFERRAL_CODE = "SIDESPACE5";
export const BUSINESS_REFERRAL_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{5,31}$/;

export function normalizeBusinessReferralCode(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function isBusinessReferralCode(value: unknown): value is string {
  return BUSINESS_REFERRAL_CODE_PATTERN.test(
    normalizeBusinessReferralCode(value),
  );
}

// A non-zero card charge must meet Stripe's USD minimum. Fully credited
// orders use a zero-cost Checkout Session instead.
export const MINIMUM_STRIPE_CHARGE_CENTS = 50;

export type AdCreditCheckout = {
  customerTotalCents: number;
  adCreditCents: number;
  chargedCampaignCents: number;
  chargedBuyerFeeCents: number;
  chargedTotalCents: number;
};

function assertSafeCents(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer in cents.`);
  }
}

export function maximumAdCreditCents(customerTotalCents: number) {
  assertSafeCents(customerTotalCents, "Customer total");
  return customerTotalCents;
}

/**
 * Apply credit to the campaign subtotal first, then to the buyer fee. This
 * keeps the Creator's agreed subtotal and payout unchanged while making the
 * promotion legible in the buyer's Checkout summary.
 */
export function applyAdCreditToCheckout(input: {
  subtotalCents: number;
  buyerFeeCents: number;
  availableCents: number;
}): AdCreditCheckout {
  assertSafeCents(input.subtotalCents, "Campaign subtotal");
  assertSafeCents(input.buyerFeeCents, "Buyer fee");
  assertSafeCents(input.availableCents, "Available ad credit");
  if (input.subtotalCents <= 0) {
    throw new RangeError("Campaign subtotal must be greater than zero.");
  }

  const customerTotalCents = input.subtotalCents + input.buyerFeeCents;
  if (!Number.isSafeInteger(customerTotalCents)) {
    throw new RangeError("Customer total must be a safe integer in cents.");
  }
  const adCreditCents = input.availableCents >= customerTotalCents
    ? customerTotalCents
    : Math.min(input.availableCents, Math.max(0, customerTotalCents - MINIMUM_STRIPE_CHARGE_CENTS));
  const campaignCreditCents = Math.min(adCreditCents, input.subtotalCents);
  const buyerFeeCreditCents = adCreditCents - campaignCreditCents;
  const chargedCampaignCents = input.subtotalCents - campaignCreditCents;
  const chargedBuyerFeeCents = input.buyerFeeCents - buyerFeeCreditCents;
  const chargedTotalCents = chargedCampaignCents + chargedBuyerFeeCents;

  return {
    customerTotalCents,
    adCreditCents,
    chargedCampaignCents,
    chargedBuyerFeeCents,
    chargedTotalCents,
  };
}
