import { describe, expect, it } from "vitest";

import {
  checkoutIdempotencyKey,
  checkoutSessionAction,
  shouldAdvanceCheckoutAttempt,
} from "../lib/payments/checkout-state";
import { getStripeAccountReadiness } from "../lib/payments/connect";
import { webhookClaimAction } from "../lib/stripe/events";

describe("creator payout eligibility", () => {
  it("requires every Stripe capability and no outstanding requirement", () => {
    expect(
      getStripeAccountReadiness({
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        requirements_due: [],
      }).ready,
    ).toBe(true);
    expect(
      getStripeAccountReadiness({
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        requirements_due: ["individual.verification.document"],
      }).ready,
    ).toBe(false);
    expect(
      getStripeAccountReadiness({
        charges_enabled: false,
        payouts_enabled: true,
        details_submitted: true,
      }).ready,
    ).toBe(false);
  });
});

describe("duplicate Checkout requests", () => {
  it("reuses an open Session, waits on a complete Session, and retries expiry", () => {
    expect(checkoutSessionAction("open")).toBe("reuse");
    expect(checkoutSessionAction("complete")).toBe("wait_for_webhook");
    expect(checkoutSessionAction(null)).toBe("wait_for_webhook");
    expect(checkoutSessionAction("expired")).toBe("new_attempt");
  });

  it("uses a new Stripe idempotency key only for a new attempt", () => {
    expect(checkoutIdempotencyKey("tx-1", 0)).toBe(
      "sidespace-checkout-tx-1-0",
    );
    expect(checkoutIdempotencyKey("tx-1", 1)).toBe(
      "sidespace-checkout-tx-1-1",
    );
    expect(() => checkoutIdempotencyKey("tx-1", -1)).toThrow(
      /non-negative integer/,
    );
  });

  it("advances after a terminal Stripe request error but not an uncertain failure", () => {
    expect(
      shouldAdvanceCheckoutAttempt({
        type: "StripeInvalidRequestError",
        statusCode: 400,
      }),
    ).toBe(true);
    expect(
      shouldAdvanceCheckoutAttempt({
        type: "StripeConnectionError",
        statusCode: 500,
      }),
    ).toBe(false);
    expect(shouldAdvanceCheckoutAttempt(new Error("network failed"))).toBe(false);
  });
});

describe("webhook replay claims", () => {
  const now = 1_000_000;

  it("skips processed events and refuses concurrent processing", () => {
    expect(
      webhookClaimAction({ status: "processed", receivedAt: 0 }, now),
    ).toBe("duplicate");
    expect(
      webhookClaimAction(
        { status: "processing", receivedAt: now - 1_000 },
        now,
      ),
    ).toBe("busy");
  });

  it("reclaims failed and stale processing events", () => {
    expect(
      webhookClaimAction({ status: "failed", receivedAt: now }, now),
    ).toBe("reclaim");
    expect(
      webhookClaimAction(
        { status: "processing", receivedAt: now - 300_001 },
        now,
      ),
    ).toBe("reclaim");
  });
});
