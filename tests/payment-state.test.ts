import { describe, expect, it } from "vitest";

import {
  checkoutIdempotencyKey,
  checkoutSessionAction,
  shouldAdvanceCheckoutAttempt,
} from "../lib/payments/checkout-state";
import { getStripeAccountReadiness } from "../lib/payments/connect";
import { participantTransactionResponse } from "../lib/payments/response";
import { webhookClaimAction } from "../lib/stripe/events";

describe("creator payout eligibility", () => {
  it("requires payouts, submitted details and no outstanding requirement", () => {
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
        charges_enabled: true,
        payouts_enabled: false,
        details_submitted: true,
        requirements_due: [],
      }).ready,
    ).toBe(false);
    expect(
      getStripeAccountReadiness({
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: false,
        requirements_due: [],
      }).ready,
    ).toBe(false);
  });

  // The shape onboarding actually produces. `capabilities: { transfers }` is
  // all connect/onboard requests, and Stripe leaves charges_enabled false for
  // a transfers-only Express account - so a creator who finished onboarding
  // correctly used to fail this gate, and every checkout against them 409'd.
  // The charge is taken on the platform account; the creator only receives a
  // transfer, so charge capability is not theirs to have.
  it("accepts a transfers-only account, which is what onboarding creates", () => {
    expect(
      getStripeAccountReadiness({
        charges_enabled: false,
        payouts_enabled: true,
        details_submitted: true,
        requirements_due: [],
        capabilities: { transfers: "active" },
      }).ready,
    ).toBe(true);
  });

  it("rejects an account whose transfers capability is not active", () => {
    expect(
      getStripeAccountReadiness({
        charges_enabled: false,
        payouts_enabled: true,
        details_submitted: true,
        requirements_due: [],
        capabilities: { transfers: "pending" },
      }).ready,
    ).toBe(false);
  });

  it("rejects an otherwise ready account outside the supported country", () => {
    expect(
      getStripeAccountReadiness({
        charges_enabled: false,
        payouts_enabled: true,
        details_submitted: true,
        country: "CA",
        requirements_due: [],
        capabilities: { transfers: "active" },
      }).ready,
    ).toBe(false);
  });

  it("rejects an account with past-due verification requirements", () => {
    expect(
      getStripeAccountReadiness({
        charges_enabled: false,
        payouts_enabled: true,
        details_submitted: true,
        requirements: { currently_due: [], past_due: ["individual.verification.document"] },
        capabilities: { transfers: "active" },
      }).ready,
    ).toBe(false);
  });

  it("rejects an account disabled by Stripe requirements", () => {
    expect(
      getStripeAccountReadiness({
        charges_enabled: false,
        payouts_enabled: true,
        details_submitted: true,
        requirements: { currently_due: [], disabled_reason: "requirements.past_due" },
        capabilities: { transfers: "active" },
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

describe("participant payment responses", () => {
  it("keeps Stripe object identifiers out of authenticated action responses", () => {
    const response = participantTransactionResponse({
      id: "transaction-1",
      status: "paid",
      workflow_status: "awaiting_payer_review",
      payout_status: "pending",
      delivered_at: null,
      review_deadline: "2026-09-02T12:00:00.000Z",
      confirmed_at: null,
      issue_status: "none",
      payout_released_at: null,
      stripe_charge_id: "ch_secret_to_redact",
      stripe_transfer_id: "tr_secret_to_redact",
    });

    expect(response).toMatchObject({
      id: "transaction-1",
      payout_status: "pending",
    });
    expect(response).not.toHaveProperty("stripe_charge_id");
    expect(response).not.toHaveProperty("stripe_transfer_id");
  });
});
