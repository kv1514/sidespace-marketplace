import { afterEach, describe, expect, it } from "vitest";

import {
  assertStripeRuntimeReady,
  getStripeWebhookSecrets,
} from "../lib/stripe/server";

const managedNames = [
  "STRIPE_SECRET_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "PAYMENTS_LIVE_ENABLED",
  "PAYMENTS_LEGAL_APPROVED",
  "PAYMENTS_TAX_APPROVED",
  "PAYMENTS_OPERATIONS_READY",
  "VERCEL_ENV",
] as const;
const original = Object.fromEntries(
  managedNames.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of managedNames) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Stripe runtime gate", () => {
  it("accepts matching sandbox keys", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_unit";
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_unit";
    expect(assertStripeRuntimeReady()).toBe("test");
  });

  it("rejects mixed key modes", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_unit";
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_unit";
    expect(() => assertStripeRuntimeReady()).toThrow(/different modes/);
  });

  it("keeps live mode locked until every approval is explicit", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_unit";
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_live_unit";
    process.env.PAYMENTS_LIVE_ENABLED = "true";
    expect(() => assertStripeRuntimeReady()).toThrow(/PAYMENTS_LEGAL_APPROVED/);
  });

  it("accepts live keys only in the approved production runtime", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_unit";
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_live_unit";
    process.env.PAYMENTS_LIVE_ENABLED = "true";
    process.env.PAYMENTS_LEGAL_APPROVED = "true";
    process.env.PAYMENTS_TAX_APPROVED = "true";
    process.env.PAYMENTS_OPERATIONS_READY = "true";
    process.env.VERCEL_ENV = "production";
    expect(assertStripeRuntimeReady()).toBe("live");
  });

  it("rejects live keys when the runtime is not Vercel Production", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_unit";
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_live_unit";
    process.env.PAYMENTS_LIVE_ENABLED = "true";
    process.env.PAYMENTS_LEGAL_APPROVED = "true";
    process.env.PAYMENTS_TAX_APPROVED = "true";
    process.env.PAYMENTS_OPERATIONS_READY = "true";
    delete process.env.VERCEL_ENV;
    expect(() => assertStripeRuntimeReady()).toThrow(/Vercel Production/);
  });

  it("supports one local listener secret and two hosted endpoint secrets", () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_platform_secret";
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    expect(getStripeWebhookSecrets()).toEqual(["whsec_platform_secret"]);

    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_secret";
    expect(getStripeWebhookSecrets()).toEqual([
      "whsec_platform_secret",
      "whsec_connect_secret",
    ]);
  });

  it("rejects a malformed hosted Connect webhook secret", () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_platform_secret";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "not-a-webhook-secret";
    expect(() => getStripeWebhookSecrets()).toThrow(/STRIPE_CONNECT_WEBHOOK_SECRET/);
  });

  it("requires a separate Connect webhook secret in live mode", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_unit";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_platform_secret";
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    expect(() => getStripeWebhookSecrets()).toThrow(/required when Stripe is live/);
  });

  it("rejects a reused platform webhook secret in live mode", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_unit";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_platform_secret";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_platform_secret";
    expect(() => getStripeWebhookSecrets()).toThrow(/must be distinct/);
  });
});
