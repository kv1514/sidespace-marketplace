export function checkoutPaymentLifecycle(input: {
  paid: boolean;
  legacyTransferId: string | null;
  payoutStatus: string;
  workflowStatus: string;
  terminalWorkflowStatus?: "payment_failed" | "expired";
}) {
  const movesToPaidPending =
    input.paid && input.payoutStatus === "not_ready" && !input.legacyTransferId;
  const movesToPaidWorkflow =
    input.paid &&
    ["requires_checkout", "checkout_open", "processing", "payment_failed"].includes(
      input.workflowStatus,
    );
  return {
    movesToPaidPending,
    movesToPaidWorkflow,
    payoutStatus: input.legacyTransferId
      ? "released"
      : movesToPaidPending
        ? "pending"
        : input.payoutStatus,
    workflowStatus: input.legacyTransferId
      ? "completed"
      : movesToPaidWorkflow
        ? "paid_payout_pending"
        : input.terminalWorkflowStatus ?? input.workflowStatus,
  };
}

export function payoutStatusAfterRefundResolution(input: {
  payoutWasReleased: boolean;
  action: "full_refund" | "partial_refund";
}) {
  if (input.payoutWasReleased) return "released" as const;
  return input.action === "full_refund" ? ("refunded" as const) : ("partially_refunded" as const);
}

export function payoutAmountAfterRefund(input: {
  originalPayoutCents: number;
  chargeAmountCents: number;
  refundedCents: number;
}) {
  if (
    !Number.isSafeInteger(input.originalPayoutCents) ||
    input.originalPayoutCents < 0 ||
    !Number.isSafeInteger(input.chargeAmountCents) ||
    input.chargeAmountCents <= 0 ||
    !Number.isSafeInteger(input.refundedCents) ||
    input.refundedCents < 0 ||
    input.refundedCents > input.chargeAmountCents
  ) {
    throw new Error("Invalid payment amounts for payout restoration.");
  }
  const remaining = BigInt(input.chargeAmountCents - input.refundedCents);
  const payout =
    (BigInt(input.originalPayoutCents) * remaining) /
    BigInt(input.chargeAmountCents);
  const result = Number(payout);
  if (!Number.isSafeInteger(result)) {
    throw new Error("The calculated payout exceeds safe integer cents.");
  }
  return result;
}

export function restorePayoutAfterRefundFailure(input: {
  nextStatus: string;
  refundStatus: string | null | undefined;
  refundedCents: number;
  currentPayoutStatus: string;
  currentWorkflowStatus: string;
  issueStatus: string;
  deliveredAt: string | null;
}) {
  const refundFailed = input.refundStatus === "failed" || input.refundStatus === "canceled";
  if (
    refundFailed &&
    input.currentPayoutStatus === "released" &&
    input.issueStatus === "none" &&
    ["paid", "partially_refunded"].includes(input.nextStatus)
  ) {
    return {
      payoutStatus: "released" as const,
      workflowStatus: "completed" as const,
    };
  }
  const canRestore =
    input.nextStatus === "paid" &&
    refundFailed &&
    input.refundedCents === 0 &&
    input.issueStatus === "none" &&
    ["blocked", "partially_refunded", "refunded"].includes(
      input.currentPayoutStatus,
    );
  if (!canRestore) {
    return {
      payoutStatus: input.currentPayoutStatus,
      workflowStatus: input.currentWorkflowStatus,
    };
  }
  return {
    payoutStatus: "pending" as const,
    workflowStatus: input.deliveredAt
      ? ("awaiting_payer_review" as const)
      : ("paid_payout_pending" as const),
  };
}
