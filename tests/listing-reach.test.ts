import { describe, expect, it } from "vitest";

import { mergeListingReach } from "../lib/listings/reach";

// Reach is merged in after the listings load, the way like counts are, so a
// failed aggregate call costs one ranking signal and never the grid.
describe("merging seven-day reach into listings", () => {
  const listings = [
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ];

  it("attaches the counts to the listing they belong to", () => {
    const merged = mergeListingReach(listings, [
      { listing_id: "a", impressions_7d: 12, clicks_7d: 3 },
    ]) as Array<Record<string, unknown>>;
    expect(merged[0]).toMatchObject({ id: "a", impressions_7d: 12, clicks_7d: 3 });
    // Untouched, not zeroed: absence of a row means "no traffic recorded".
    expect(merged[1]).toEqual({ id: "b", title: "B" });
  });

  it("leaves the listings alone when the aggregate did not load", () => {
    expect(mergeListingReach(listings, null)).toBe(listings);
    expect(mergeListingReach(listings, undefined)).toBe(listings);
  });

  it("never lets a bad row turn into a negative or fractional count", () => {
    const merged = mergeListingReach(listings, [
      { listing_id: "a", impressions_7d: "-4", clicks_7d: 2.7 },
      { listing_id: 42, impressions_7d: 1, clicks_7d: 1 },
      null,
    ]) as Array<Record<string, unknown>>;
    expect(merged[0]).toMatchObject({ impressions_7d: 0, clicks_7d: 2 });
  });
});
