import { describe, expect, it } from "vitest";

import {
  MAXIMUM_UNDERCUT_BASIS_POINTS,
  MINIMUM_OFFER_CENTS,
  checkOfferAmount,
  offerFloorCents,
} from "../lib/payments/offer-floor";

// These numbers are duplicated in
// supabase/migrations/20260907120000_offer_and_counteroffer_floors.sql, which
// is the copy that actually holds - the browser writes campaign requests
// directly. Any change here has to be made there too, or the client will
// cheerfully accept an amount the database then refuses.
describe("how low the paying side may go", () => {
  it("keeps 40% of the amount already on the table", () => {
    expect(offerFloorCents(90_000, "payer")).toBe(36_000);
    expect(offerFloorCents(250_000, "payer")).toBe(100_000);
  });

  it("rounds the share up, so a rounding cent cannot widen the cut", () => {
    // 40% of $1,000.01 is 40,000.4 cents. Rounding down would allow a cut of
    // marginally more than the 60% the rule permits.
    expect(offerFloorCents(100_001, "payer")).toBe(40_001);
  });

  it("never falls below the $2 minimum, however cheap the listing is", () => {
    expect(offerFloorCents(0, "payer")).toBe(MINIMUM_OFFER_CENTS);
    expect(offerFloorCents(1, "payer")).toBe(MINIMUM_OFFER_CENTS);
    expect(offerFloorCents(500, "payer")).toBe(MINIMUM_OFFER_CENTS);
    // $5.01 is the first reference whose 40% clears $2 on its own.
    expect(offerFloorCents(501, "payer")).toBe(201);
  });

  it("is exactly the undercut the constants describe", () => {
    const reference = 1_000_000;
    const cut = reference - offerFloorCents(reference, "payer");
    expect(cut).toBe((reference * MAXIMUM_UNDERCUT_BASIS_POINTS) / 10_000);
  });

  it("refuses a reference that is not an amount", () => {
    expect(() => offerFloorCents(-1, "payer")).toThrow(RangeError);
    expect(() => offerFloorCents(1.5, "payer")).toThrow(RangeError);
  });
});

// A seller naming a smaller number is agreeing to be paid less, not lowballing
// anyone, so the undercut floor does not reach them - only the $2 minimum does.
describe("how low the side being paid may go", () => {
  it("is floored at $2 and nothing more, whatever is on the table", () => {
    expect(offerFloorCents(90_000, "payee")).toBe(MINIMUM_OFFER_CENTS);
    expect(offerFloorCents(1_000_000, "payee")).toBe(MINIMUM_OFFER_CENTS);
    expect(offerFloorCents(0, "payee")).toBe(MINIMUM_OFFER_CENTS);
  });

  it("may undercut the amount on the table as far as it likes", () => {
    // A creator pitching $50 against a $900 brief: 94% below, and allowed.
    expect(
      checkOfferAmount({ amountCents: 5_000, referenceCents: 90_000, side: "payee" }),
    ).toEqual({ ok: true });
    // The same number from the buying side is not.
    expect(
      checkOfferAmount({ amountCents: 5_000, referenceCents: 90_000, side: "payer" }),
    ).toEqual({ ok: false, reason: "undercuts_reference", floorCents: 36_000 });
  });

  it("still cannot propose under $2", () => {
    expect(
      checkOfferAmount({ amountCents: 199, referenceCents: 90_000, side: "payee" }),
    ).toEqual({
      ok: false,
      reason: "below_minimum",
      floorCents: MINIMUM_OFFER_CENTS,
    });
  });
});

describe("what the paying side may offer", () => {
  const asking = 90_000;

  it("accepts the floor and everything above it", () => {
    for (const amount of [36_000, 36_001, 90_000, 500_000]) {
      expect(
        checkOfferAmount({ amountCents: amount, referenceCents: asking, side: "payer" }),
      ).toEqual({ ok: true });
    }
  });

  it("refuses one cent under the floor, and says what the floor is", () => {
    expect(
      checkOfferAmount({ amountCents: 35_999, referenceCents: asking, side: "payer" }),
    ).toEqual({ ok: false, reason: "undercuts_reference", floorCents: 36_000 });
  });

  it("refuses anything under $2 even when 40% of the listing is less", () => {
    expect(
      checkOfferAmount({ amountCents: 199, referenceCents: 100, side: "payer" }),
    ).toEqual({
      ok: false,
      reason: "below_minimum",
      floorCents: MINIMUM_OFFER_CENTS,
    });
  });

  it("hands back the counteroffer floor a business has to clear on its brief", () => {
    expect(
      checkOfferAmount({ amountCents: 10_000, referenceCents: 36_000, side: "payer" }),
    ).toEqual({ ok: false, reason: "undercuts_reference", floorCents: 14_400 });
  });

  it("never caps the upside: asking for more is an ordinary ask", () => {
    expect(
      checkOfferAmount({ amountCents: 10_000_000, referenceCents: 200, side: "payer" }),
    ).toEqual({ ok: true });
  });

  it("reports a broken amount rather than throwing at the caller", () => {
    expect(
      checkOfferAmount({ amountCents: Number.NaN, referenceCents: asking, side: "payer" }),
    ).toEqual({ ok: false, reason: "not_an_amount", floorCents: 36_000 });
  });
});
