import { describe, expect, it } from "vitest";

import {
  comparePopularListings,
  normalizeLikeCount,
  popularityScore,
} from "../lib/listings/popularity";
import { mergeListingLikeCounts } from "../lib/listings/likes";

const now = Date.parse("2026-09-03T12:00:00.000Z");

function listing(
  overrides: Partial<Parameters<typeof popularityScore>[0]> = {},
) {
  return {
    title: "Neighborhood launch story",
    format: "One Instagram post + story",
    description:
      "A clear, detailed placement for a local business reaching nearby customers.",
    created_at: "2026-09-02T12:00:00.000Z",
    owner: { verified: false, is_demo: false },
    like_count: 0,
    ...overrides,
  };
}

describe("listing popularity", () => {
  it("gives a fresh listing room to outrank an old one", () => {
    expect(
      popularityScore(listing(), now),
    ).toBeGreaterThan(
      popularityScore(
        listing({ created_at: "2025-09-03T12:00:00.000Z" }),
        now,
      ),
    );
  });

  it("uses diminishing returns for likes", () => {
    const firstLikeLift =
      popularityScore(listing({ like_count: 1 }), now) -
      popularityScore(listing({ like_count: 0 }), now);
    const hundredthLikeLift =
      popularityScore(listing({ like_count: 101 }), now) -
      popularityScore(listing({ like_count: 100 }), now);

    expect(firstLikeLift).toBeGreaterThan(hundredthLikeLift);
  });

  it("rewards useful detail and verified owners alongside interest", () => {
    const completeAndVerified = listing({
      owner: { verified: true, is_demo: false },
    });
    const thinAndUnverified = listing({
      title: "Post",
      format: "IG",
      description: "Reach.",
    });

    expect(popularityScore(completeAndVerified, now)).toBeGreaterThan(
      popularityScore(thinAndUnverified, now),
    );
    expect(comparePopularListings(thinAndUnverified, completeAndVerified, now)).toBeGreaterThan(0);
  });

  it("never lets demo inventory earn a popularity boost", () => {
    expect(
      popularityScore(
        listing({ like_count: 10_000, owner: { verified: true, is_demo: true } }),
        now,
      ),
    ).toBe(0);
  });

  it("normalizes aggregate counts defensively", () => {
    expect(normalizeLikeCount("12")).toBe(12);
    expect(normalizeLikeCount(-1)).toBe(0);
    expect(normalizeLikeCount("not-a-count")).toBe(0);
  });

  it("keeps listings usable when a count response is unavailable", () => {
    const rows = [{ id: "listing-1", title: "First" }, { id: "listing-2", title: "Second" }];
    expect(
      mergeListingLikeCounts(rows, [{ listing_id: "listing-1", like_count: "4" }]),
    ).toEqual([
      { id: "listing-1", title: "First", like_count: 4 },
      { id: "listing-2", title: "Second" },
    ]);
    expect(mergeListingLikeCounts(rows, null)).toEqual(rows);
  });
});

describe("views in the popularity prior", () => {
  it("lifts a listing people keep reaching this week", () => {
    expect(
      popularityScore(listing({ impressions_7d: 40, clicks_7d: 9 }), now),
    ).toBeGreaterThan(popularityScore(listing(), now));
  });

  it("counts an open as more than a scroll past", () => {
    const opened = popularityScore(listing({ clicks_7d: 5 }), now);
    const passed = popularityScore(listing({ impressions_7d: 5 }), now);
    expect(opened).toBeGreaterThan(passed);
  });

  it("still lets one like outweigh a click or a handful of impressions", () => {
    const base = popularityScore(listing(), now);
    const oneLike = popularityScore(listing({ like_count: 1 }), now) - base;
    const oneClick = popularityScore(listing({ clicks_7d: 1 }), now) - base;
    const tenViews = popularityScore(listing({ impressions_7d: 10 }), now) - base;
    expect(oneLike).toBeGreaterThan(oneClick);
    expect(oneLike).toBeGreaterThan(tenViews);
  });

  it("dampens reach so a viral week cannot bury everything else for good", () => {
    const base = popularityScore(listing(), now);
    const first = popularityScore(listing({ impressions_7d: 10 }), now) - base;
    const thousandth =
      popularityScore(listing({ impressions_7d: 1010 }), now) -
      popularityScore(listing({ impressions_7d: 1000 }), now);
    expect(first).toBeGreaterThan(thousandth * 20);
  });

  it("treats missing reach as zero rather than as a number", () => {
    expect(popularityScore(listing({ impressions_7d: null, clicks_7d: undefined }), now)).toBe(
      popularityScore(listing(), now),
    );
  });
});
