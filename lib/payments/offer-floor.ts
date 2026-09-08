import { BASIS_POINTS_PER_WHOLE } from "./fees";

/**
 * How low a proposition is allowed to go.
 *
 * A negotiation here is two numbers passed back and forth: one side proposes,
 * the other counters. Neither number was bounded, so a $900 window could be
 * offered $5. That is not a negotiation - it costs the other side a
 * notification and a decision, and lowballing at that scale is the cheapest
 * way to make a marketplace this size feel worthless to the people supplying
 * it.
 *
 * Two floors, expressed once, in a form the browser and the database can both
 * apply to the same number:
 *
 *   * THE SIDE THAT WOULD PAY may not undercut the amount already on the table
 *     by more than 60%.
 *   * Nobody may propose anything under $2. Below that the card fee is most of
 *     the money and neither side is really transacting.
 *
 * The undercut floor binds the buying side only. A seller naming a smaller
 * number is not lowballing anyone - they are agreeing to be paid less, which
 * is theirs to decide, and on a business brief the creator pitching against
 * the brief is the seller. Going UP is not capped on either side: asking for
 * more than was offered is an ordinary ask, and the other side can decline it.
 */

/** The least anyone may put on the table, whatever the reference amount is. */
export const MINIMUM_OFFER_CENTS = 200;

/** How far below the reference the paying side may sit: 60%. */
export const MAXIMUM_UNDERCUT_BASIS_POINTS = 6_000;

/**
 * Which side of the money the proposer is on.
 *
 * "payer" is whoever would be charged if this were accepted - the member
 * making an offer on a supply listing, or the business countering a pitch on
 * its own brief. "payee" is the side being paid, and only the $2 minimum
 * binds them.
 */
export type ProposerSide = "payer" | "payee";

/**
 * Which amount anchors the floor.
 *
 * Always the number the OTHER party last put up - the listed price for a first
 * offer, the member's budget for a counteroffer - never the proposer's own
 * previous number. Anchoring a revised counteroffer to the proposer's own
 * earlier one would forbid them from conceding toward the other side, which is
 * the direction a revision usually moves.
 */
export type OfferCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "below_minimum" | "undercuts_reference" | "not_an_amount";
      floorCents: number;
    };

/**
 * The lowest amount `side` may propose against `referenceCents`.
 *
 * For the paying side the percentage share rounds UP, so the rounding cent can
 * never widen the cut past the 60% the rule allows.
 */
export function offerFloorCents(referenceCents: number, side: ProposerSide) {
  if (!Number.isSafeInteger(referenceCents) || referenceCents < 0) {
    throw new RangeError(
      "Reference amount must be a non-negative safe integer in cents.",
    );
  }
  if (side === "payee") return MINIMUM_OFFER_CENTS;
  const whole = BigInt(BASIS_POINTS_PER_WHOLE);
  const kept = BigInt(BASIS_POINTS_PER_WHOLE - MAXIMUM_UNDERCUT_BASIS_POINTS);
  const share = (BigInt(referenceCents) * kept + whole - BigInt(1)) / whole;
  const minimum = BigInt(MINIMUM_OFFER_CENTS);
  return Number(share > minimum ? share : minimum);
}

/**
 * Whether `amountCents` may be proposed against `referenceCents`, and which
 * rule turned it down.
 *
 * Deliberately no sentence: the wording differs between an offer and a
 * counteroffer, and copy the interface shows has to be a literal at the call
 * site or the message scanner cannot find a translation for it.
 */
export function checkOfferAmount({
  amountCents,
  referenceCents,
  side,
}: {
  amountCents: number;
  referenceCents: number;
  side: ProposerSide;
}): OfferCheck {
  const floorCents = offerFloorCents(referenceCents, side);
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    return { ok: false, reason: "not_an_amount", floorCents };
  }
  if (amountCents < MINIMUM_OFFER_CENTS) {
    return { ok: false, reason: "below_minimum", floorCents };
  }
  if (amountCents < floorCents) {
    return { ok: false, reason: "undercuts_reference", floorCents };
  }
  return { ok: true };
}
