import { BASIS_POINTS_PER_WHOLE } from "./fees";

/**
 * How low a proposition is allowed to go.
 *
 * A negotiation here is two numbers passed back and forth: a member offers,
 * the owner counters. Nothing bounded either number, so a $900 window could be
 * "offered" $5 and a $2,000 pitch countered at $20. Those are not
 * negotiations - they cost the other side a notification and a decision, and
 * lowballing at that scale is the cheapest way to make a marketplace this size
 * feel worthless to the people supplying it.
 *
 * Two floors, expressed once, in a form the browser and the database can both
 * apply to the same number:
 *
 *   * A proposition may not undercut the amount already on the table by more
 *     than 60%.
 *   * Nothing may be proposed under $2 at all. Below that the card fee is most
 *     of the money and neither side is really transacting.
 *
 * Going UP is deliberately not capped. Asking for more than was offered is an
 * ordinary ask, and the other side can simply decline it.
 */

/** The least anyone may put on the table, whatever the reference amount is. */
export const MINIMUM_OFFER_CENTS = 200;

/** How far below the reference a proposition may sit: 60%. */
export const MAXIMUM_UNDERCUT_BASIS_POINTS = 6_000;

/**
 * Which side's number anchors the floor.
 *
 * Always the amount the OTHER party last put up - the listed price for a first
 * offer, the member's budget for a counteroffer - never the proposer's own
 * previous number. Anchoring an owner's revised counteroffer to their own
 * earlier counteroffer would forbid them from conceding toward the buyer,
 * which is the one direction a revision usually moves.
 */
export type OfferCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "below_minimum" | "undercuts_reference" | "not_an_amount";
      floorCents: number;
    };

/**
 * The lowest amount that may be proposed against `referenceCents`.
 *
 * The percentage share rounds UP, so the rounding cent can never widen the cut
 * past the 60% the rule allows.
 */
export function offerFloorCents(referenceCents: number) {
  if (!Number.isSafeInteger(referenceCents) || referenceCents < 0) {
    throw new RangeError(
      "Reference amount must be a non-negative safe integer in cents.",
    );
  }
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
}: {
  amountCents: number;
  referenceCents: number;
}): OfferCheck {
  const floorCents = offerFloorCents(referenceCents);
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
