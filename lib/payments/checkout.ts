import type Stripe from "stripe";
import type { PaymentBreakdown } from "./fees";

export type CheckoutSnapshot = PaymentBreakdown & {
  transactionId: string;
  campaignRequestId: string;
  campaignName: string;
  listingTitle: string;
  creatorProfileId: string;
  customerId: string;
};

export function getAppOrigin(requestUrl: string) {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
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

  return {
    mode: "payment",
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
        },
      },
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: snapshot.subtotalCents,
          tax_behavior: "exclusive",
          product_data: {
            name: snapshot.campaignName,
            description: snapshot.listingTitle,
            tax_code: campaignTaxCode,
            metadata: { sidespace_kind: "campaign_subtotal" },
          },
        },
      },
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: snapshot.buyerFeeCents,
          tax_behavior: "exclusive",
          product_data: {
            name: "SideSpace buyer service fee (5%)",
            tax_code: serviceFeeTaxCode,
            metadata: { sidespace_kind: "buyer_service_fee" },
          },
        },
      },
    ],
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
    },
    success_url: `${origin}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/dashboard?checkout=cancelled`,
  };
}
