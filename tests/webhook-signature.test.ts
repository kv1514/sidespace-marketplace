import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import {
  assertStripeCheckoutAmounts,
  assertStripeMoneyMatchesLedger,
  isStaleCheckoutSession,
  verifyStripeWebhookEvent,
  verifyStripeWebhookEventWithSecrets,
} from "../lib/stripe/webhook";

const stripe = new Stripe("sk_test_unit_test_key");
const secret = "whsec_unit_test_secret";
const payload = JSON.stringify({
  id: "evt_test_signature",
  object: "event",
  type: "checkout.session.completed",
  livemode: false,
  api_version: "2026-06-30.basil",
  created: 1_700_000_000,
  data: { object: { id: "cs_test_123", object: "checkout.session" } },
});

describe("Stripe webhook signature gate", () => {
  it("accepts an authentic test-mode event", () => {
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    });
    expect(
      verifyStripeWebhookEvent(stripe, payload, signature, secret),
    ).toMatchObject({ id: "evt_test_signature", livemode: false });
  });

  it("rejects an invalid signature", () => {
    expect(() =>
      verifyStripeWebhookEvent(stripe, payload, "t=1,v1=invalid", secret),
    ).toThrow(/signature/i);
  });

  it("rejects a signed event from the wrong Stripe mode", () => {
    const livePayload = payload.replace('"livemode":false', '"livemode":true');
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: livePayload,
      secret,
    });
    expect(() =>
      verifyStripeWebhookEvent(stripe, livePayload, signature, secret),
    ).toThrow(/mode does not match/);
  });

  it("accepts a signed live event only when live mode is expected", () => {
    const livePayload = payload.replace('"livemode":false', '"livemode":true');
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: livePayload,
      secret,
    });
    expect(
      verifyStripeWebhookEvent(stripe, livePayload, signature, secret, true),
    ).toMatchObject({ id: "evt_test_signature", livemode: true });
  });

  it("accepts a signature from either the platform or Connect endpoint secret", () => {
    const connectSecret = "whsec_connect_endpoint_secret";
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: connectSecret,
    });
    expect(
      verifyStripeWebhookEventWithSecrets(
        stripe,
        payload,
        signature,
        [secret, connectSecret],
      ),
    ).toMatchObject({ id: "evt_test_signature", livemode: false });
  });
});

describe("Stripe Checkout ledger amount gate", () => {
  const base = {
    amountSubtotal: 10_500,
    amountTotal: 11_550,
    chargedTotalCents: 10_500,
    taxCents: 1_050,
    paymentStatus: "paid",
  } as const;

  it("accepts the trusted subtotal plus Stripe-calculated tax", () => {
    expect(() => assertStripeCheckoutAmounts(base)).not.toThrow();
  });

  it("rejects a paid session whose tax-inclusive total differs", () => {
    expect(() =>
      assertStripeCheckoutAmounts({ ...base, amountTotal: 11_549 }),
    ).toThrow(/total does not match/);
  });

  it("does not require an amount total for an unpaid expiry event", () => {
    expect(() =>
      assertStripeCheckoutAmounts({
        ...base,
        amountTotal: null,
        paymentStatus: "unpaid",
      }),
    ).not.toThrow();
  });

  it("rejects a charge or PaymentIntent whose money differs from the ledger", () => {
    expect(() =>
      assertStripeMoneyMatchesLedger({
        objectName: "Charge",
        amount: 10_499,
        currency: "usd",
        expectedAmountCents: 10_500,
        expectedCurrency: "usd",
      }),
    ).toThrow(/does not match/);
    expect(() =>
      assertStripeMoneyMatchesLedger({
        objectName: "PaymentIntent",
        amount: 10_500,
        currency: "eur",
        expectedAmountCents: 10_500,
        expectedCurrency: "usd",
      }),
    ).toThrow(/does not match/);
  });

  it("identifies an expired Checkout Session superseded by a newer attempt", () => {
    expect(isStaleCheckoutSession("cs_new", "cs_old")).toBe(true);
    expect(isStaleCheckoutSession("cs_new", "cs_new")).toBe(false);
    expect(isStaleCheckoutSession(null, "cs_first")).toBe(false);
  });
});
