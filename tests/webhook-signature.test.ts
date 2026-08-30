import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { verifyStripeWebhookEvent } from "../lib/stripe/webhook";

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

  it("rejects a signed live-mode event", () => {
    const livePayload = payload.replace('"livemode":false', '"livemode":true');
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: livePayload,
      secret,
    });
    expect(() =>
      verifyStripeWebhookEvent(stripe, livePayload, signature, secret),
    ).toThrow(/Live-mode events are disabled/);
  });
});
