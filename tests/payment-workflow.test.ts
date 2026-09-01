import { describe, expect, it } from "vitest";

import {
  checkoutPaymentLifecycle,
  payoutAmountAfterRefund,
  payoutStatusAfterRefundResolution,
  restorePayoutAfterRefundFailure,
} from "../lib/payments/workflow";

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

  it("records terminal failed and expired checkout workflow states", () => {
    expect(
      checkoutPaymentLifecycle({
        paid: false,
        legacyTransferId: null,
        payoutStatus: "not_ready",
        workflowStatus: "checkout_open",
        terminalWorkflowStatus: "payment_failed",
      }).workflowStatus,
    ).toBe("payment_failed");
    expect(
      checkoutPaymentLifecycle({
        paid: false,
        legacyTransferId: null,
        payoutStatus: "not_ready",
        workflowStatus: "checkout_open",
        terminalWorkflowStatus: "expired",
      }).workflowStatus,
    ).toBe("expired");
  });

  it("allows a delayed-payment retry to become payout-ready after failure", () => {
    expect(
      checkoutPaymentLifecycle({
        paid: true,
        legacyTransferId: null,
        payoutStatus: "not_ready",
        workflowStatus: "payment_failed",
      }),
    ).toMatchObject({
      movesToPaidPending: true,
      movesToPaidWorkflow: true,
      payoutStatus: "pending",
      workflowStatus: "paid_payout_pending",
    });
  });
});

describe("refund resolution payout state", () => {
  it("restores payout from the actual refunded total using integer-cent math", () => {
    expect(
      payoutAmountAfterRefund({
        originalPayoutCents: 9_500,
        chargeAmountCents: 10_500,
        refundedCents: 1_000,
      }),
    ).toBe(8_595);
    expect(
      payoutAmountAfterRefund({
        originalPayoutCents: 9_500,
        chargeAmountCents: 10_500,
        refundedCents: 0,
      }),
    ).toBe(9_500);
  });

  it("never regresses a released payout after a late resolution webhook", () => {
    expect(
      payoutStatusAfterRefundResolution({
        payoutWasReleased: true,
        action: "full_refund",
      }),
    ).toBe("released");
    expect(
      payoutStatusAfterRefundResolution({
        payoutWasReleased: true,
        action: "partial_refund",
      }),
    ).toBe("released");
  });

  it("keeps pre-release refund resolutions in their refund state", () => {
    expect(
      payoutStatusAfterRefundResolution({
        payoutWasReleased: false,
        action: "full_refund",
      }),
    ).toBe("refunded");
    expect(
      payoutStatusAfterRefundResolution({
        payoutWasReleased: false,
        action: "partial_refund",
      }),
    ).toBe("partially_refunded");
  });
});

describe("failed refund payout restoration", () => {
  const base = {
    nextStatus: "paid",
    refundStatus: "failed",
    refundedCents: 0,
    currentPayoutStatus: "refunded",
    currentWorkflowStatus: "refunded",
    issueStatus: "none",
  } as const;

  it("restores the pending payout flow after a failed pre-delivery refund", () => {
    expect(
      restorePayoutAfterRefundFailure({ ...base, deliveredAt: null }),
    ).toEqual({
      payoutStatus: "pending",
      workflowStatus: "paid_payout_pending",
    });
  });

  it("restores the review window flow after a canceled post-delivery refund", () => {
    expect(
      restorePayoutAfterRefundFailure({
        ...base,
        refundStatus: "canceled",
        deliveredAt: "2026-08-30T12:00:00.000Z",
        currentPayoutStatus: "blocked",
        currentWorkflowStatus: "partially_refunded",
      }),
    ).toEqual({
      payoutStatus: "pending",
      workflowStatus: "awaiting_payer_review",
    });
  });

  it("does not unblock a staff resolution or an already released payout", () => {
    expect(
      restorePayoutAfterRefundFailure({
        ...base,
        deliveredAt: null,
        currentPayoutStatus: "blocked",
        currentWorkflowStatus: "refund_pending",
        issueStatus: "resolution_pending",
      }),
    ).toEqual({ payoutStatus: "blocked", workflowStatus: "refund_pending" });
    expect(
      restorePayoutAfterRefundFailure({
        ...base,
        deliveredAt: null,
        currentPayoutStatus: "released",
        currentWorkflowStatus: "refund_pending",
      }),
    ).toEqual({ payoutStatus: "released", workflowStatus: "completed" });
  });
});
