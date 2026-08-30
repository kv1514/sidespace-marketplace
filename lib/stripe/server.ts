import "server-only";

import Stripe from "stripe";

let stripeClient: Stripe | undefined;

export function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured.");
  if (!secretKey.startsWith("sk_test_")) {
    throw new Error("SideSpace is configured for Stripe test-mode keys only.");
  }
  stripeClient ??= new Stripe(secretKey, {
    appInfo: { name: "SideSpace", version: "1.0.0" },
  });
  return stripeClient;
}

export function getStripeWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret?.startsWith("whsec_")) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured.");
  }
  return secret;
}
