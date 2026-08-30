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
