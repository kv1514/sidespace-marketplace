import { describe, expect, it } from "vitest";

import { checkoutPaymentLifecycle } from "../lib/payments/workflow";

describe("verified Checkout payment lifecycle", () => {
  it("marks the customer charge paid while leaving Creator payout pending", () => {
    expect(
      checkoutPaymentLifecycle({
        paid: true,
        legacyTransferId: null,
        payoutStatus: "not_ready",
        workflowStatus: "checkout_open",
      }),
    ).toMatchObject({
      payoutStatus: "pending",
      workflowStatus: "paid_payout_pending",
      movesToPaidPending: true,
    });
  });

  it("does not regress delivery state on a duplicate successful webhook", () => {
    expect(
      checkoutPaymentLifecycle({
        paid: true,
        legacyTransferId: null,
        payoutStatus: "pending",
        workflowStatus: "awaiting_payer_review",
      }),
    ).toMatchObject({
      payoutStatus: "pending",
      workflowStatus: "awaiting_payer_review",
      movesToPaidPending: false,
      movesToPaidWorkflow: false,
    });
  });

  it("recognizes legacy destination transfers so they cannot be paid twice", () => {
    expect(
      checkoutPaymentLifecycle({
        paid: true,
        legacyTransferId: "tr_legacy",
        payoutStatus: "not_ready",
        workflowStatus: "checkout_open",
      }),
    ).toMatchObject({ payoutStatus: "released", workflowStatus: "completed" });
  });
});

