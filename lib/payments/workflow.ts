export function checkoutPaymentLifecycle(input: {
  paid: boolean;
  legacyTransferId: string | null;
  payoutStatus: string;
  workflowStatus: string;
}) {
  const movesToPaidPending =
    input.paid && input.payoutStatus === "not_ready" && !input.legacyTransferId;
  const movesToPaidWorkflow =
    input.paid &&
    ["requires_checkout", "checkout_open", "processing"].includes(
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
        : input.workflowStatus,
  };
}

