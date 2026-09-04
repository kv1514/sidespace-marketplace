import { normalizeLikeCount } from "./popularity";

export const LISTING_LIKE_COUNT_COLUMNS = "listing_id,like_count";

/** Merge an aggregate count query without making listing retrieval depend on it. */
export function mergeListingLikeCounts(value: unknown, counts: unknown) {
  if (!Array.isArray(value) || !Array.isArray(counts)) return value;

  const countsByListingId = new Map<string, number>();
  for (const row of counts) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.listing_id !== "string") continue;
    countsByListingId.set(record.listing_id, normalizeLikeCount(record.like_count));
  }

  return value.map((item) => {
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !countsByListingId.has(record.id)) return item;
    return { ...record, like_count: countsByListingId.get(record.id) };
  });
}
