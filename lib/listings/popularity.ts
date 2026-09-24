import { hasOwnCover, type CoverListing } from "./cover";
import {
  RATING_PRIOR_AVERAGE,
  bayesianRating,
  type RatingListing,
} from "./ratings";

export type PopularityListing = RatingListing &
  CoverListing & {
    /** Distinct visitors who reached the card in the last seven days. */
    impressions_7d?: number | string | null;
    /** Of those, how many opened it. */
    clicks_7d?: number | string | null;
    created_at?: string | null;
    title?: string | null;
    format?: string | null;
    description?: string | null;
    /** Only read to exempt a business brief from the missing-cover penalty. */
    channel?: string | null;
    owner?: {
      verified?: boolean | null;
      is_demo?: boolean | null;
      /** Compared against the cover: a profile picture is not a photo of the space. */
      avatar_url?: string | null;
    } | null;
  };

const DAY_MS = 86_400_000;

/**
 * How far a rating can move a listing, up or down: about 17 points either way
 * at the extremes, which is the same order as freshness (18) and a strong
 * week's reach.
 *
 * Signed, and that is the point. Every other term here can only add, so the
 * score answered "how much has happened to this listing" and a thin listing
 * with a stock photo and some traffic could sit above a good one. A rating is
 * the one signal that is allowed to say a listing is worse than nothing was
 * known about it.
 */
const RATING_WEIGHT = 12;

/**
 * What a card showing the seeded stock photo costs it.
 *
 * Nine points - half a fresh listing's freshness - because this is the single
 * most visible quality signal on the grid and the one a business reads first.
 * A wall nobody photographed is not comparable to a wall with three photos of
 * it, whatever the traffic says, and the grid used to rank them side by side.
 *
 * A business brief is exempt: a brief is a wanted ad written before there is
 * anything to photograph, and it is drawn with the hatched panel rather than
 * the stock frame precisely so it does not pretend otherwise.
 */
const STOCK_COVER_PENALTY = 9;

export function normalizeLikeCount(value: unknown) {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function textLength(value: unknown) {
  return typeof value === "string" ? value.trim().length : 0;
}

/**
 * How much the crowd's stars move this listing, relative to an unrated one.
 *
 * Exactly 0 with no ratings, because `bayesianRating` returns the prior there:
 * an unrated listing is an open question and must not be scored as a bad one,
 * or nothing new would ever collect a first rating.
 */
export function ratingScore(listing: RatingListing) {
  return (bayesianRating(listing) - RATING_PRIOR_AVERAGE) * RATING_WEIGHT;
}

/**
 * Blend what raters said with freshness, reach and how finished the listing is.
 *
 * Can be negative: a badly-rated listing, or one that never got a photo, is
 * meant to sort below one nobody has said anything about yet. Callers that
 * turn this into a multiplier must clamp it (see `personalScore`).
 */
export function popularityScore(listing: PopularityListing, nowMs = Date.now()) {
  if (listing.owner?.is_demo) return 0;

  const createdAtMs = typeof listing.created_at === "string" ? Date.parse(listing.created_at) : Number.NaN;
  const ageDays = Number.isFinite(createdAtMs)
    ? Math.max(0, nowMs - createdAtMs) / DAY_MS
    : 365;
  const freshnessScore = 18 / (1 + ageDays / 14);
  const completenessScore =
    (textLength(listing.title) >= 8 ? 1.5 : 0) +
    (textLength(listing.format) >= 10 ? 1.5 : 0) +
    (textLength(listing.description) >= 60 ? 1.5 : 0);
  const trustScore = listing.owner?.verified ? 2 : 0;
  const coverPenalty =
    listing.channel !== "Business brief" && !hasOwnCover(listing) ? STOCK_COVER_PENALTY : 0;
  // Reach, dampened twice: a log so a viral week cannot bury everything else
  // for good, and a seven-day window so it has to keep happening. A click is
  // intent and counts for more than a card scrolled past - an open is somebody
  // deciding to find out more, which is the closest thing the grid has to the
  // thing a business is about to do.
  const reachScore =
    Math.log1p(normalizeLikeCount(listing.clicks_7d)) * 5 +
    Math.log1p(normalizeLikeCount(listing.impressions_7d)) * 1.5;

  return (
    freshnessScore +
    ratingScore(listing) +
    completenessScore +
    trustScore +
    reachScore -
    coverPenalty
  );
}

export function comparePopularListings(
  first: PopularityListing,
  second: PopularityListing,
  nowMs = Date.now(),
) {
  return popularityScore(second, nowMs) - popularityScore(first, nowMs);
}
