import "server-only";

import Stripe from "stripe";

let stripeClient: Stripe | undefined;
let stripeClientKey: string | undefined;

function enabled(name: string) {
  return process.env[name] === "true";
}

export function stripeKeyMode() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured.");
  if (secretKey.startsWith("sk_test_")) return "test" as const;
  if (secretKey.startsWith("sk_live_")) return "live" as const;
  throw new Error("STRIPE_SECRET_KEY is not a recognized Stripe secret key.");
}

export function assertStripeRuntimeReady() {
  const mode = stripeKeyMode();
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey?.startsWith(mode === "live" ? "pk_live_" : "pk_test_")) {
    throw new Error("Stripe publishable and secret keys are from different modes.");
  }
  if (mode === "test") return mode;

  const requiredApprovals = [
    "PAYMENTS_LIVE_ENABLED",
    "PAYMENTS_LEGAL_APPROVED",
    "PAYMENTS_TAX_APPROVED",
    "PAYMENTS_OPERATIONS_READY",
  ];
  const missing = requiredApprovals.filter((name) => !enabled(name));
  if (missing.length) {
    throw new Error(`Live Stripe is locked. Missing: ${missing.join(", ")}.`);
  }
  if (process.env.VERCEL_ENV !== "production") {
    throw new Error("Live Stripe keys are only allowed in Vercel Production.");
  }
  return mode;
}

export function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  assertStripeRuntimeReady();
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured.");
  if (!stripeClient || stripeClientKey !== secretKey) {
    stripeClient = new Stripe(secretKey, {
      appInfo: { name: "SideSpace", version: "1.0.0" },
      maxNetworkRetries: 2,
    });
    stripeClientKey = secretKey;
  }
  return stripeClient;
}

export function getStripeWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret?.startsWith("whsec_")) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured.");
  }
  return secret;
}

export function getStripeWebhookSecrets() {
  const primary = getStripeWebhookSecret();
  const connected = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (connected !== undefined && !connected.startsWith("whsec_")) {
    throw new Error("STRIPE_CONNECT_WEBHOOK_SECRET is not configured.");
  }
  if (process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_")) {
    if (!connected) {
      throw new Error(
        "STRIPE_CONNECT_WEBHOOK_SECRET is required when Stripe is live.",
      );
    }
    if (connected === primary) {
      throw new Error(
        "Platform and Connect webhook secrets must be distinct in live mode.",
      );
    }
  }
  // Stripe CLI uses one signing secret for both normal and Connect forwards.
  // Hosted Stripe endpoints have separate secrets, so production can provide
  // the second value without breaking local forwarding.
  return connected ? [primary, connected] : [primary];
}
