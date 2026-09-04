export type PopularityListing = {
  like_count?: number | string | null;
  created_at?: string | null;
  title?: string | null;
  format?: string | null;
  description?: string | null;
  owner?: {
    verified?: boolean | null;
    is_demo?: boolean | null;
  } | null;
};

const DAY_MS = 86_400_000;

export function normalizeLikeCount(value: unknown) {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function textLength(value: unknown) {
  return typeof value === "string" ? value.trim().length : 0;
}

/**
 * Blend community interest with freshness and listing quality. Likes use a
 * logarithmic curve so a large incumbent audience cannot permanently crowd
 * out newer listings.
 */
export function popularityScore(listing: PopularityListing, nowMs = Date.now()) {
  if (listing.owner?.is_demo) return 0;

  const createdAtMs = typeof listing.created_at === "string" ? Date.parse(listing.created_at) : Number.NaN;
  const ageDays = Number.isFinite(createdAtMs)
    ? Math.max(0, nowMs - createdAtMs) / DAY_MS
    : 365;
  const freshnessScore = 18 / (1 + ageDays / 14);
  const likeScore = Math.log1p(normalizeLikeCount(listing.like_count)) * 12;
  const completenessScore =
    (textLength(listing.title) >= 8 ? 1.5 : 0) +
    (textLength(listing.format) >= 10 ? 1.5 : 0) +
    (textLength(listing.description) >= 60 ? 1.5 : 0);
  const trustScore = listing.owner?.verified ? 2 : 0;

  return freshnessScore + likeScore + completenessScore + trustScore;
}

export function comparePopularListings(
  first: PopularityListing,
  second: PopularityListing,
  nowMs = Date.now(),
) {
  return popularityScore(second, nowMs) - popularityScore(first, nowMs);
}
