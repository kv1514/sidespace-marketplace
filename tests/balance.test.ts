import { describe, expect, it, vi } from "vitest";
import { ledgerCents, summarizeEarnings, summarizeStripeBalance, type EarningsRow } from "../lib/payments/balance";
import { readBalancePages } from "../lib/payments/balance-server";

const paid: EarningsRow = {
  currency: "usd", paid_at: "2026-09-03T00:00:00Z", status: "paid", payout_status: "released",
  payout_amount_cents: 9500, payout_recovery_target_cents: 0, payout_recovery_reversed_cents: 0,
};

describe("account balances", () => {
  it("keeps current Stripe funds separate by currency and supports negative balances", () => {
    expect(summarizeStripeBalance({ available: [{ currency: "usd", amount: -100 }, { currency: "eur", amount: 500 }], pending: [{ currency: "usd", amount: 200 }] })).toEqual([
      { currency: "eur", availableCents: 500, pendingCents: 0 }, { currency: "usd", availableCents: -100, pendingCents: 200 },
    ]);
  });
  it("counts released net earnings, pending campaigns and reversals without double counting", () => {
    expect(summarizeEarnings([
      paid,
      { ...paid, payout_amount_cents: 2000, payout_status: "pending" },
      { ...paid, paid_at: null },
      { ...paid, status: "refunded", payout_status: "refunded", payout_amount_cents: 0 },
      { ...paid, payout_recovery_target_cents: 1000, payout_recovery_reversed_cents: 500 },
      { ...paid, currency: "eur", payout_amount_cents: 300 },
    ])).toEqual([{ currency: "eur", earnedCents: 300, pendingCents: 0 }, { currency: "usd", earnedCents: 18000, pendingCents: 2000 }]);
  });
  it.each([null, undefined, "", "1.1", 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid financial amounts (%s)", (amount) => expect(() => ledgerCents(amount)).toThrow());
  it("reads beyond the API row cap, even when the server returns smaller pages", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ id: i }));
    const read = vi.fn(async (from: number) => ({ data: rows.slice(from, from + 300), error: null, count: rows.length }));
    expect(await readBalancePages(read)).toHaveLength(1001);
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("fails rather than showing a partial total after a page fails", async () => {
    await expect(readBalancePages(async () => ({ data: null, error: new Error("Database unavailable"), count: null }))).rejects.toThrow("Database unavailable");
  });
});
