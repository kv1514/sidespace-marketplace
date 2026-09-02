import type Stripe from "stripe";
import {
  applyAdCreditToCheckout,
  MINIMUM_STRIPE_CHARGE_CENTS,
} from "./ad-credits";
import type { PaymentBreakdown } from "./fees";

export type CheckoutSnapshot = PaymentBreakdown & {
  transactionId: string;
  campaignRequestId: string;
  campaignName: string;
  listingTitle: string;
  creatorProfileId: string;
  customerId: string;
  /** Reserved by the server-side ad-credit ledger for this checkout attempt. */
  adCreditCents?: number;
  chargedCampaignCents?: number;
  chargedBuyerFeeCents?: number;
  chargedTotalCents?: number;
  minimumChargedCents?: number;
};

export function getAppOrigin(requestUrl: string) {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (configured) {
    const url = new URL(configured);
    const localDevelopmentOrigin =
      process.env.NODE_ENV !== "production" && url.hostname === "localhost";
    if (url.protocol !== "https:" && !localDevelopmentOrigin) {
      throw new Error("NEXT_PUBLIC_APP_URL must use HTTPS outside localhost.");
    }
    return url.origin;
  }
  const requestOrigin = new URL(requestUrl).origin;
  if (process.env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_APP_URL is required in production.");
  }
  return requestOrigin;
}

export function buildCheckoutSessionParams(
  snapshot: CheckoutSnapshot,
  origin: string,
): Stripe.Checkout.SessionCreateParams {
  const campaignTaxCode = process.env.STRIPE_CAMPAIGN_TAX_CODE ?? "txcd_20030000";
  const serviceFeeTaxCode =
    process.env.STRIPE_SERVICE_FEE_TAX_CODE ?? "txcd_20030000";
  const minimumChargedCents = Math.max(
    MINIMUM_STRIPE_CHARGE_CENTS,
    snapshot.minimumChargedCents ?? snapshot.creatorPayoutCents,
  );
  const discounted = applyAdCreditToCheckout({
    subtotalCents: snapshot.subtotalCents,
    buyerFeeCents: snapshot.buyerFeeCents,
    availableCents: snapshot.adCreditCents ?? 0,
    minimumChargedCents,
  });
  const chargedCampaignCents =
    snapshot.chargedCampaignCents ?? discounted.chargedCampaignCents;
  const chargedBuyerFeeCents =
    snapshot.chargedBuyerFeeCents ?? discounted.chargedBuyerFeeCents;
  const chargedTotalCents =
    snapshot.chargedTotalCents ?? discounted.chargedTotalCents;
  if (
    discounted.customerTotalCents !== snapshot.customerTotalCents ||
    discounted.adCreditCents !== (snapshot.adCreditCents ?? 0) ||
    chargedCampaignCents !== discounted.chargedCampaignCents ||
    chargedBuyerFeeCents !== discounted.chargedBuyerFeeCents ||
    chargedTotalCents !== discounted.chargedTotalCents
  ) {
    throw new Error("Checkout credit amounts do not match the trusted ledger.");
  }
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  if (chargedCampaignCents > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: chargedCampaignCents,
        tax_behavior: "exclusive",
        product_data: {
          name: snapshot.campaignName,
          description: snapshot.listingTitle,
          tax_code: campaignTaxCode,
          metadata: { sidespace_kind: "campaign_subtotal" },
        },
      },
    });
  }
  if (chargedBuyerFeeCents > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: chargedBuyerFeeCents,
        tax_behavior: "exclusive",
        product_data: {
          name: "SideSpace buyer service fee (5%)",
          tax_code: serviceFeeTaxCode,
          metadata: { sidespace_kind: "buyer_service_fee" },
        },
      },
    });
  }

  return {
    mode: "payment",
    // Launch with cards only. Delayed bank methods can succeed after the
    // customer leaves Checkout, which is unsafe when a separate Connect
    // transfer is released as soon as the review window ends.
    payment_method_types: ["card"],
    customer: snapshot.customerId,
    client_reference_id: snapshot.transactionId,
    billing_address_collection: "required",
    customer_update: { address: "auto", name: "auto" },
    automatic_tax: {
      enabled: true,
      liability: { type: "self" },
    },
    invoice_creation: {
      enabled: true,
      invoice_data: {
        issuer: { type: "self" },
        description: `SideSpace campaign: ${snapshot.campaignName}`,
        metadata: {
          sidespace_transaction_id: snapshot.transactionId,
          sidespace_campaign_request_id: snapshot.campaignRequestId,
          sidespace_ad_credit_cents: String(discounted.adCreditCents),
        },
      },
    },
    line_items: lineItems,
    payment_intent_data: {
      // This is intentionally a platform charge. Creator earnings stay in the
      // SideSpace platform balance until delivery is confirmed or the 72-hour
      // review window expires, at which point a separate Connect transfer is
      // created by a secure server action.
      transfer_group: `sidespace_campaign_${snapshot.transactionId}`,
      metadata: {
        sidespace_transaction_id: snapshot.transactionId,
        sidespace_campaign_request_id: snapshot.campaignRequestId,
        sidespace_creator_profile_id: snapshot.creatorProfileId,
      },
    },
    metadata: {
      sidespace_transaction_id: snapshot.transactionId,
      sidespace_campaign_request_id: snapshot.campaignRequestId,
      sidespace_ad_credit_cents: String(discounted.adCreditCents),
    },
    success_url: `${origin}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/dashboard?checkout=cancelled`,
  };
}
