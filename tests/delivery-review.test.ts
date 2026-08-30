import { describe, expect, it } from "vitest";

import {
  REVIEW_WINDOW_MS,
  isAutoReleaseDue,
  payoutTransferIdempotencyKey,
  reviewDeadline,
} from "../lib/payments/review";

describe("72-hour delivery review", () => {
  const deliveredAt = new Date("2026-08-30T12:00:00.000Z");

  it("sets the deadline to exactly 72 hours after delivery", () => {
    expect(reviewDeadline(deliveredAt).getTime() - deliveredAt.getTime()).toBe(
      REVIEW_WINDOW_MS,
    );
    expect(reviewDeadline(deliveredAt).toISOString()).toBe(
      "2026-09-02T12:00:00.000Z",
    );
  });

  it("never auto-releases before the deadline and becomes due exactly at it", () => {
    const deadline = reviewDeadline(deliveredAt);
    expect(isAutoReleaseDue(deadline, new Date(deadline.getTime() - 1))).toBe(false);
    expect(isAutoReleaseDue(deadline, deadline)).toBe(true);
    expect(isAutoReleaseDue(deadline, new Date(deadline.getTime() + 1))).toBe(true);
  });

  it("uses one stable Stripe idempotency key for every release retry", () => {
    expect(payoutTransferIdempotencyKey("transaction-1")).toBe(
      "sidespace-payout-transaction-1",
    );
    expect(payoutTransferIdempotencyKey("transaction-1")).toBe(
      payoutTransferIdempotencyKey("transaction-1"),
    );
  });
});

