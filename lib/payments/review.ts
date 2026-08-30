export const REVIEW_WINDOW_MS = 72 * 60 * 60 * 1000;

export function reviewDeadline(deliveredAt: Date | string) {
  const delivered = new Date(deliveredAt);
  if (Number.isNaN(delivered.getTime())) {
    throw new Error("A valid delivery time is required.");
  }
  return new Date(delivered.getTime() + REVIEW_WINDOW_MS);
}

export function isAutoReleaseDue(
  reviewDeadlineValue: Date | string | null,
  now: Date | string = new Date(),
) {
  if (!reviewDeadlineValue) return false;
  const deadline = new Date(reviewDeadlineValue).getTime();
  const current = new Date(now).getTime();
  return Number.isFinite(deadline) && Number.isFinite(current) && current >= deadline;
}

export function payoutTransferIdempotencyKey(transactionId: string) {
  if (!transactionId) throw new Error("A transaction ID is required.");
  return `sidespace-payout-${transactionId}`;
}

