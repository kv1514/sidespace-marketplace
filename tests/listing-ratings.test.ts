import { describe, expect, it } from "vitest";

import {
  MAX_STARS,
  RATING_PRIOR_AVERAGE,
  bayesianRating,
  formatRatingAverage,
  mergeListingRatings,
  normalizeRatingCount,
  normalizeStars,
  ratingSummary,
  starFill,
} from "../lib/listings/ratings";

function rated(stars: number, count: number) {
  return { rating_count: count, rating_sum: stars * count };
}

describe("one person's rating", () => {
  it("keeps a rating inside the five stars the interface can draw", () => {
    expect(normalizeStars(4)).toBe(4);
    expect(normalizeStars("5")).toBe(5);
    expect(normalizeStars(9)).toBe(MAX_STARS);
    expect(normalizeStars(3.4)).toBe(3);
    expect(normalizeStars(3.6)).toBe(4);
  });

  it("reads anything that is not a rating as no rating, never as one star", () => {
    // The distinction the whole model rests on: unrated is an open question,
    // one star is a verdict. Collapsing them would score every new listing as
    // though somebody had hated it.
    expect(normalizeStars(0)).toBe(0);
    expect(normalizeStars(-3)).toBe(0);
    expect(normalizeStars(null)).toBe(0);
    expect(normalizeStars("not-a-rating")).toBe(0);
    expect(normalizeStars(undefined)).toBe(0);
  });

  it("normalizes aggregate counts defensively", () => {
    expect(normalizeRatingCount("12")).toBe(12);
    expect(normalizeRatingCount(-1)).toBe(0);
    expect(normalizeRatingCount("not-a-count")).toBe(0);
  });
});

describe("what a listing's raters add up to", () => {
  it("reports the plain mean and the count for the label", () => {
    expect(ratingSummary(rated(4.5, 8))).toEqual({ count: 8, average: 4.5 });
    expect(formatRatingAverage(rated(4.25, 4))).toBe("4.3");
  });

  it("says nothing at all about a listing nobody has rated", () => {
    expect(ratingSummary({ rating_count: 0, rating_sum: 0 })).toEqual({
      count: 0,
      average: 0,
    });
    expect(formatRatingAverage({})).toBe("");
  });

  it("survives a sum without a count, and a count without a sum", () => {
    expect(ratingSummary({ rating_count: 4, rating_sum: 0 }).average).toBe(0);
    expect(ratingSummary({ rating_count: 0, rating_sum: 20 }).average).toBe(0);
  });
});

describe("the average a listing has actually earned", () => {
  it("treats an unrated listing as an open question, not a bad one", () => {
    expect(bayesianRating({})).toBe(RATING_PRIOR_AVERAGE);
    expect(bayesianRating(rated(0, 0))).toBe(RATING_PRIOR_AVERAGE);
  });

  it("keeps one perfect rating well short of a perfect score", () => {
    const one = bayesianRating(rated(5, 1));
    expect(one).toBeGreaterThan(RATING_PRIOR_AVERAGE);
    expect(one).toBeLessThan(4);
  });

  it("lets forty good ratings beat one perfect one", () => {
    expect(bayesianRating(rated(4.6, 40))).toBeGreaterThan(bayesianRating(rated(5, 1)));
  });

  it("converges on what the raters said once enough of them agree", () => {
    expect(bayesianRating(rated(4.8, 400))).toBeCloseTo(4.8, 1);
    expect(bayesianRating(rated(1.5, 400))).toBeCloseTo(1.5, 1);
  });

  it("pulls a single one-star rating up, for the same reason it pulls a five down", () => {
    // Shrinkage has to cut both ways or it is just a thumb on the scale. One
    // angry rating is not yet evidence that a listing is bad.
    const one = bayesianRating(rated(1, 1));
    expect(one).toBeLessThan(RATING_PRIOR_AVERAGE);
    expect(one).toBeGreaterThan(3);
  });
});

describe("painting the stars", () => {
  it("rounds to the nearest half so 4.3 does not look like 4.0", () => {
    expect(starFill(4.3)).toBe(4.5);
    expect(starFill(4.2)).toBe(4);
    expect(starFill(4.8)).toBe(5);
  });

  it("draws nothing for an unrated listing and never more than five", () => {
    expect(starFill(0)).toBe(0);
    expect(starFill(-1)).toBe(0);
    expect(starFill(Number.NaN)).toBe(0);
    expect(starFill(12)).toBe(MAX_STARS);
  });
});

describe("merging the aggregate into the grid", () => {
  it("attaches counts to the listings it has them for", () => {
    const rows = [{ id: "listing-1", title: "First" }, { id: "listing-2", title: "Second" }];
    expect(
      mergeListingRatings(rows, [
        { listing_id: "listing-1", rating_count: "3", rating_sum: "14" },
      ]),
    ).toEqual([
      { id: "listing-1", title: "First", rating_count: 3, rating_sum: 14 },
      { id: "listing-2", title: "Second" },
    ]);
  });

  it("keeps listings usable when the stats call failed", () => {
    const rows = [{ id: "listing-1", title: "First" }];
    expect(mergeListingRatings(rows, null)).toEqual(rows);
    expect(mergeListingRatings(rows, undefined)).toEqual(rows);
  });

  it("ignores rows that are not shaped like stats", () => {
    const rows = [{ id: "listing-1", title: "First" }];
    expect(mergeListingRatings(rows, [null, 7, { rating_count: 3 }])).toEqual(rows);
  });
});
