export function checkoutSessionAction(
  status: string | null,
) {
  if (status === "open") return "reuse" as const;
  if (status === "expired") return "new_attempt" as const;
  return "wait_for_webhook" as const;
}

export function checkoutIdempotencyKey(
  transactionId: string,
  checkoutAttempt: number,
) {
  if (!Number.isSafeInteger(checkoutAttempt) || checkoutAttempt < 0) {
    throw new Error("Checkout attempt must be a non-negative integer.");
  }
  return `sidespace-checkout-${transactionId}-${checkoutAttempt}`;
}

export function shouldAdvanceCheckoutAttempt(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { type?: unknown; statusCode?: unknown };
  return (
    candidate.type === "StripeInvalidRequestError" &&
    typeof candidate.statusCode === "number" &&
    candidate.statusCode >= 400 &&
    candidate.statusCode < 500
  );
}
