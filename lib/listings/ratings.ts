/**
 * What people who used a listing thought of it, on five stars.
 *
 * This replaces the heart. A heart answered "did anyone like this at all",
 * which any listing with one loyal friend could win, and it could only ever go
 * up. A star asks how good the placement actually was, and it can go down. A
 * business deciding where to spend money is asking the second question, so
 * that is the one the grid now answers.
 *
 * Same promise as `listing_like_counts` before it: the browser reads an
 * aggregate - a count and a sum per listing - and never a row saying who rated
 * what. Rounding is deliberately not done in SQL; the view hands back integers
 * and the average is computed here, so there is one implementation of it and
 * no float drift between the ranking and the label.
 */

export const LISTING_RATING_STAT_COLUMNS = "listing_id,rating_count,rating_sum";

export const MIN_STARS = 1;
export const MAX_STARS = 5;

/**
 * The average a listing is assumed to deserve before anybody has said
 * otherwise, and how many ratings' worth of doubt that assumption is worth.
 *
 * This is the whole reason a rating can be trusted to sort a grid. A raw
 * average lets one five-star rating from the owner's roommate beat forty
 * ratings averaging 4.8, which is how star ranking usually fails. Shrinking
 * toward the prior means a listing has to earn its way up: at one rating it
 * sits most of the way back at 3.6, and by about twenty it is saying what its
 * raters said.
 *
 * 3.6 rather than 3.0 because people rate a marketplace listing generously -
 * the same reason a 4.7 driver is unremarkable and a 4.2 is a warning. A prior
 * at the arithmetic middle would flatter every badly-rated listing.
 */
export const RATING_PRIOR_AVERAGE = 3.6;
export const RATING_PRIOR_WEIGHT = 6;

export type RatingListing = {
  rating_count?: number | string | null;
  rating_sum?: number | string | null;
};

export type RatingSummary = {
  /** How many people rated it. */
  count: number;
  /** The plain arithmetic mean, for the label. 0 when nobody has rated it. */
  average: number;
};

/** A non-negative whole number, or 0 for anything that is not one. */
export function normalizeRatingCount(value: unknown) {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * One person's rating, clamped to the five stars the interface can show.
 *
 * 0 means "not rated", which is distinct from 1 star - a listing nobody has
 * rated must not be treated as a listing everybody hated.
 */
export function normalizeStars(value: unknown) {
  const stars = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(stars) || stars < MIN_STARS) return 0;
  return Math.min(MAX_STARS, Math.round(stars));
}

/** Count and plain mean, the two numbers the star label is built from. */
export function ratingSummary(listing: RatingListing): RatingSummary {
  const count = normalizeRatingCount(listing.rating_count);
  const sum = normalizeRatingCount(listing.rating_sum);
  if (!count || !sum) return { count, average: 0 };
  return { count, average: Math.min(MAX_STARS, sum / count) };
}

/**
 * The average a listing has actually earned: its raters' mean, pulled toward
 * `RATING_PRIOR_AVERAGE` by however little evidence there is.
 *
 * Returns `RATING_PRIOR_AVERAGE` for a listing nobody has rated, not 0. An
 * unrated listing is an open question, and scoring it zero would rank it below
 * every one-star listing on the site - which is how a new listing would never
 * get its first rating.
 */
export function bayesianRating(listing: RatingListing) {
  const { count, average } = ratingSummary(listing);
  if (!count) return RATING_PRIOR_AVERAGE;
  return (
    (average * count + RATING_PRIOR_AVERAGE * RATING_PRIOR_WEIGHT) /
    (count + RATING_PRIOR_WEIGHT)
  );
}

/** The label a card shows: "4.8" and how many said so. */
export function formatRatingAverage(listing: RatingListing) {
  const { average } = ratingSummary(listing);
  return average ? average.toFixed(1) : "";
}

/**
 * How many of five stars to paint solid, to the nearest half.
 *
 * Halves rather than whole stars because 4.4 and 4.6 are a real difference to
 * somebody choosing, and rounding both to four stars hides it.
 */
export function starFill(average: number) {
  if (!Number.isFinite(average) || average <= 0) return 0;
  return Math.min(MAX_STARS, Math.round(average * 2) / 2);
}

/**
 * Merge the aggregate view into listing rows without making the grid depend on
 * it. Exactly `mergeListingLikeCounts`' contract: if the call failed, listings
 * still render and the ranking has one signal fewer.
 */
export function mergeListingRatings(value: unknown, rows: unknown) {
  if (!Array.isArray(value) || !Array.isArray(rows)) return value;

  const statsByListingId = new Map<string, { rating_count: number; rating_sum: number }>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.listing_id !== "string") continue;
    statsByListingId.set(record.listing_id, {
      rating_count: normalizeRatingCount(record.rating_count),
      rating_sum: normalizeRatingCount(record.rating_sum),
    });
  }

  return value.map((item) => {
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string") return item;
    const stats = statsByListingId.get(record.id);
    if (!stats) return item;
    return { ...record, ...stats };
  });
}
