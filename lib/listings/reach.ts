import { normalizeLikeCount } from "./popularity";

/**
 * Seven-day reach per listing, for ranking.
 *
 * Comes from `public.listing_reach()`, an aggregate over `listing_events` that
 * returns counts and never a visitor - the same shape and the same promise as
 * `listing_like_counts`. Merged in after the fact, exactly like like counts,
 * so listing retrieval never depends on it: if the call fails the grid still
 * renders and the ranking simply has one signal fewer.
 */
export const LISTING_REACH_RPC = "listing_reach";

export function mergeListingReach(value: unknown, rows: unknown) {
  if (!Array.isArray(value) || !Array.isArray(rows)) return value;

  const reachByListingId = new Map<string, { impressions_7d: number; clicks_7d: number }>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.listing_id !== "string") continue;
    reachByListingId.set(record.listing_id, {
      impressions_7d: normalizeLikeCount(record.impressions_7d),
      clicks_7d: normalizeLikeCount(record.clicks_7d),
    });
  }

  return value.map((item) => {
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string") return item;
    const reach = reachByListingId.get(record.id);
    if (!reach) return item;
    return { ...record, ...reach };
  });
}
