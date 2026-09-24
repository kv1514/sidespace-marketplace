import { describe, expect, it } from "vitest";

import {
  comparePopularListings,
  normalizeLikeCount,
  popularityScore,
  ratingScore,
} from "../lib/listings/popularity";
import { mergeListingLikeCounts } from "../lib/listings/likes";
import { RATING_PRIOR_AVERAGE } from "../lib/listings/ratings";

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
    image_url: "/photos/a-photo-of-the-actual-space.jpg",
    rating_count: 0,
    rating_sum: 0,
    ...overrides,
  };
}

/** `count` ratings that all gave `stars`. */
function rated(stars: number, count: number) {
  return { rating_count: count, rating_sum: stars * count };
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
        listing({ ...rated(5, 500), owner: { verified: true, is_demo: true } }),
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

describe("what raters did to the popularity prior", () => {
  it("scores an unrated listing exactly as if the rating term were absent", () => {
    // The whole reason `bayesianRating` returns the prior rather than 0: a
    // listing nobody has rated is an open question, not a bad review. If this
    // drifts, nothing new ever collects a first rating.
    expect(ratingScore(rated(0, 0))).toBe(0);
    expect(popularityScore(listing(), now)).toBe(
      popularityScore(listing({ rating_count: null, rating_sum: undefined }), now),
    );
  });

  it("lifts a well-rated listing and pushes a badly-rated one below unrated", () => {
    const unrated = popularityScore(listing(), now);
    expect(popularityScore(listing(rated(5, 40)), now)).toBeGreaterThan(unrated);
    expect(popularityScore(listing(rated(2, 40)), now)).toBeLessThan(unrated);
  });

  it("does not let one five-star rating beat a long run of good ones", () => {
    // The failure mode star ranking usually ships with. One perfect rating is
    // mostly prior; forty at 4.6 have earned their way up past it.
    const onePerfect = popularityScore(listing(rated(5, 1)), now);
    const fortyGood = popularityScore(listing(rated(4.6, 40)), now);
    expect(fortyGood).toBeGreaterThan(onePerfect);
  });

  it("moves further from the prior as more people agree", () => {
    const shrunkAtOne = ratingScore(rated(5, 1));
    const shrunkAtTwenty = ratingScore(rated(5, 20));
    expect(shrunkAtTwenty).toBeGreaterThan(shrunkAtOne);
    expect(shrunkAtOne).toBeGreaterThan(0);
  });

  it("treats a rating exactly at the prior as saying nothing", () => {
    expect(ratingScore(rated(RATING_PRIOR_AVERAGE, 30))).toBeCloseTo(0, 6);
  });
});

describe("a card with no photo of what it is selling", () => {
  it("demotes a listing that never got a cover", () => {
    const withPhoto = popularityScore(listing(), now);
    const withNothing = popularityScore(listing({ image_url: null, image_urls: [] }), now);
    expect(withNothing).toBeLessThan(withPhoto);
  });

  it("demotes a listing whose cover is the owner's profile picture", () => {
    // The live case this was written for: a 96px Google account avatar - a
    // letter on a coloured circle - stretched across a marketplace card.
    const avatar = "https://lh3.googleusercontent.com/a/ACg8ocExample=s96-c";
    const ownPhoto = popularityScore(listing(), now);
    const justTheAvatar = popularityScore(
      listing({
        image_url: avatar,
        owner: { verified: false, is_demo: false, avatar_url: avatar },
      }),
      now,
    );
    expect(justTheAvatar).toBeLessThan(ownPhoto);
  });

  it("leaves a business brief alone, because it has nothing to photograph yet", () => {
    const brief = { channel: "Business brief", image_url: null, image_urls: [] };
    expect(popularityScore(listing({ ...brief }), now)).toBe(
      popularityScore(listing({ ...brief, channel: "Business brief" }), now),
    );
    expect(popularityScore(listing({ ...brief }), now)).toBeGreaterThan(
      popularityScore(listing({ image_url: null, image_urls: [] }), now),
    );
  });

  it("still counts a real upload that happens to sit beside the seeded frame", () => {
    expect(
      popularityScore(
        listing({ image_urls: ["/photos/market-creator.jpg", "/uploads/the-wall.jpg"] }),
        now,
      ),
    ).toBe(popularityScore(listing(), now));
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

  it("lets a week of real traffic outweigh a small rating edge", () => {
    // "More traffic" has to mean something, or the grid cannot tell a listing
    // people are actually opening from one with three polite ratings.
    const quietAndSlightlyBetter = popularityScore(listing(rated(4.4, 3)), now);
    const busyAndOrdinary = popularityScore(
      listing({ ...rated(4.0, 3), impressions_7d: 400, clicks_7d: 60 }),
      now,
    );
    expect(busyAndOrdinary).toBeGreaterThan(quietAndSlightlyBetter);
  });
});
