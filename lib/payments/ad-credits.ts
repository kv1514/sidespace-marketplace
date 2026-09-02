/**
 * SideSpace ad credits are a platform-funded promotion for Business buyers.
 * They reduce what the buyer pays at Checkout; they never change the Creator's
 * agreed campaign amount or payout.
 */
export const BUSINESS_SIGNUP_CREDIT_CENTS = 500;
export const BUSINESS_REFERRAL_CODE = "SIDESPACE5";

export function normalizeBusinessReferralCode(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function isBusinessReferralCode(value: unknown): value is string {
  return normalizeBusinessReferralCode(value) === BUSINESS_REFERRAL_CODE;
}

// Stripe payout reconciliation requires a real platform charge because the
// Creator transfer is sourced from that charge. Keep a small remainder for
// campaigns whose total is smaller than the available credit.
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

export function maximumAdCreditCents(
  customerTotalCents: number,
  minimumChargedCents = MINIMUM_STRIPE_CHARGE_CENTS,
) {
  assertSafeCents(customerTotalCents, "Customer total");
  assertSafeCents(minimumChargedCents, "Minimum charged amount");
  return Math.max(
    0,
    customerTotalCents -
      Math.max(MINIMUM_STRIPE_CHARGE_CENTS, minimumChargedCents),
  );
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
  /** Also protects a source_transaction-backed Creator payout. */
  minimumChargedCents?: number;
}): AdCreditCheckout {
  assertSafeCents(input.subtotalCents, "Campaign subtotal");
  assertSafeCents(input.buyerFeeCents, "Buyer fee");
  assertSafeCents(input.availableCents, "Available ad credit");
  assertSafeCents(
    input.minimumChargedCents ?? MINIMUM_STRIPE_CHARGE_CENTS,
    "Minimum charged amount",
  );
  if (input.subtotalCents <= 0) {
    throw new RangeError("Campaign subtotal must be greater than zero.");
  }

  const customerTotalCents = input.subtotalCents + input.buyerFeeCents;
  if (!Number.isSafeInteger(customerTotalCents)) {
    throw new RangeError("Customer total must be a safe integer in cents.");
  }
  const adCreditCents = Math.min(
    input.availableCents,
    maximumAdCreditCents(
      customerTotalCents,
      input.minimumChargedCents ?? MINIMUM_STRIPE_CHARGE_CENTS,
    ),
  );
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
