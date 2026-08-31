import { describe, expect, it } from "vitest";

import {
  calculatePaymentBreakdown,
  dollarsToCents,
  percentageFeeCents,
} from "../lib/payments/fees";

describe("SideSpace 5% + 5% marketplace economics", () => {
  it.each([
    ["$1.00", 100, 5, 105, 95, 10],
    ["$10.00", 1_000, 50, 1_050, 950, 100],
    ["$99.99", 9_999, 500, 10_499, 9_499, 1_000],
    ["$100.00", 10_000, 500, 10_500, 9_500, 1_000],
    ["$500.00", 50_000, 2_500, 52_500, 47_500, 5_000],
    ["$1,000.00", 100_000, 5_000, 105_000, 95_000, 10_000],
  ])(
    "%s produces exact buyer, creator, and platform amounts",
    (_label, subtotal, eachFee, total, payout, platformGross) => {
      expect(calculatePaymentBreakdown(subtotal)).toEqual({
        subtotalCents: subtotal,
        buyerFeeCents: eachFee,
        creatorFeeCents: eachFee,
        customerTotalCents: total,
        creatorPayoutCents: payout,
        platformGrossRevenueCents: platformGross,
      });
    },
  );

  it("rounds each percentage fee to the nearest cent", () => {
    expect(percentageFeeCents(1, 500)).toBe(0);
    expect(percentageFeeCents(9, 500)).toBe(0);
    expect(percentageFeeCents(10, 500)).toBe(1);
    expect(percentageFeeCents(11, 500)).toBe(1);
    expect(percentageFeeCents(9_999, 500)).toBe(500);
  });

  it("parses dollars without floating-point money math", () => {
    expect(dollarsToCents("0.01")).toBe(1);
    expect(dollarsToCents("99.99")).toBe(9_999);
    expect(dollarsToCents(100)).toBe(10_000);
    expect(() => dollarsToCents("12.345")).toThrow(/two decimals/);
    expect(() => dollarsToCents("-1")).toThrow();
  });

  it("rejects invalid cents", () => {
    expect(() => calculatePaymentBreakdown(0)).toThrow(/greater than zero/);
    expect(() => calculatePaymentBreakdown(10.5)).toThrow(/safe integer/);
    expect(() => calculatePaymentBreakdown(-1)).toThrow(/non-negative/);
  });
});

// The database enforces the same arithmetic in `payment_transaction_fee_math`:
//
//   CHECK (customer_total_cents  = subtotal_cents + buyer_fee_cents
//      AND creator_payout_cents  = subtotal_cents - creator_fee_cents
//      AND platform_gross_revenue_cents = buyer_fee_cents + creator_fee_cents)
//
// A breakdown that violates it does not fail a unit test - it fails the INSERT in
// `api/stripe/checkout`, as an opaque 23514 in production, on every payment.
// So assert the constraint here, where a rounding change gets caught in CI.
describe("breakdowns satisfy the payment_transactions CHECK constraints", () => {
  const subtotals = [
    1, 2, 9, 10, 11, 33, 99, 101, 333, 999, 1_001, 4_999, 9_999, 10_001,
    12_345, 50_505, 99_999, 123_456, 1_000_001,
  ];

  it.each(subtotals)("a $%d-cent subtotal inserts cleanly", (subtotal) => {
    const b = calculatePaymentBreakdown(subtotal);

    expect(b.customerTotalCents).toBe(b.subtotalCents + b.buyerFeeCents);
    expect(b.creatorPayoutCents).toBe(b.subtotalCents - b.creatorFeeCents);
    expect(b.platformGrossRevenueCents).toBe(b.buyerFeeCents + b.creatorFeeCents);

    // The column-level `>= 0` / `> 0` checks on the same table.
    expect(b.subtotalCents).toBeGreaterThan(0);
    expect(b.customerTotalCents).toBeGreaterThan(0);
    expect(b.buyerFeeCents).toBeGreaterThanOrEqual(0);
    expect(b.creatorFeeCents).toBeGreaterThanOrEqual(0);
    expect(b.creatorPayoutCents).toBeGreaterThanOrEqual(0);
    expect(b.platformGrossRevenueCents).toBeGreaterThanOrEqual(0);
  });
});
