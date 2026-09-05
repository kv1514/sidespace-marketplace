import { describe, expect, it } from "vitest";

import {
  COOCCURRENCE_CONFIDENCE,
  buildAffinity,
  buildIdf,
  contentSimilarity,
  normalizeCity,
  normalizeTerm,
  priceProximity,
  recommendListings,
  textSimilarity,
  type CooccurrenceIndex,
  type RecommendListing,
} from "../lib/listings/recommend";

const now = Date.parse("2026-09-04T12:00:00.000Z");
const DAY = 86_400_000;

function listing(overrides: Partial<RecommendListing> & { id: string }): RecommendListing {
  return {
    title: "Instagram story for local businesses",
    channel: "Instagram",
    format: "one Instagram story, live for 24 hours",
    description:
      "A story post to my local following, shown to people who actually live nearby.",
    location_area: "Berkeley, CA",
    price_cents: 4000,
    status: "active",
    like_count: 0,
    created_at: "2026-09-01T12:00:00.000Z",
    owner: { id: "owner-" + overrides.id, categories: ["Local"], verified: false, is_demo: false },
    ...overrides,
  };
}

/** A catalogue with real variety, shaped like the live one. */
function catalogue(): RecommendListing[] {
  return [
    listing({ id: "ig-1" }),
    listing({ id: "ig-2", title: "Instagram post on my account", price_cents: 5000 }),
    listing({
      id: "wall-1",
      title: "Wall or mural in Berkeley",
      channel: "Wall / mural",
      format: "6x7 wall or mural for a week",
      description: "A brick wall facing a busy pavement, painted or postered.",
      price_cents: 12000,
      owner: { id: "owner-wall", categories: ["Art"], is_demo: false },
    }),
    listing({
      id: "car-1",
      title: "Poster on my rear car window",
      channel: "Vehicle",
      format: "a poster on my rear car window",
      description: "My car is parked around campus most days and driven daily.",
      location_area: "Brea, CA",
      price_cents: 1500,
      owner: { id: "owner-car", categories: ["Local"], is_demo: false },
    }),
    listing({
      id: "yt-1",
      title: "30-second segment in my next YouTube video",
      channel: "YouTube",
      format: "a 30-second sponsored segment",
      description: "A read inside my next upload, to a subscriber base that watches through.",
      location_area: "Yorba Linda, CA",
      price_cents: 4000,
      owner: { id: "owner-yt", categories: ["Video"], is_demo: false },
    }),
  ];
}

describe("normalisation", () => {
  it("folds the case and punctuation that the live data actually carries", () => {
    // These exact pairs are live in production right now.
    expect(normalizeTerm("Food & drink")).toBe("food drink");
    expect(normalizeTerm("food")).toBe(normalizeTerm("Food"));
    expect(normalizeTerm("College")).toBe(normalizeTerm("college"));
    expect(normalizeTerm("Wall / mural")).toBe("wall mural");
  });

  it("treats one place spelled several ways as one place", () => {
    expect(normalizeCity("Berkeley, CA")).toBe("berkeley");
    expect(normalizeCity("Berkeley")).toBe("berkeley");
    expect(normalizeCity("Fullerton, CA and online")).toBe("fullerton");
    expect(normalizeCity("Fullerton")).toBe("fullerton");
  });
});

describe("price proximity", () => {
  it("measures distance as a multiple, not a difference", () => {
    const near = priceProximity(
      listing({ id: "a", price_cents: 1000 }),
      listing({ id: "b", price_cents: 2000 }),
    );
    const far = priceProximity(
      listing({ id: "a", price_cents: 1000 }),
      listing({ id: "b", price_cents: 100000 }),
    );
    expect(near).toBeGreaterThan(far);
    // $10 vs $40 sits the same distance apart as $1,000 vs $4,000.
    expect(
      priceProximity(listing({ id: "a", price_cents: 1000 }), listing({ id: "b", price_cents: 4000 })),
    ).toBeCloseTo(
      priceProximity(
        listing({ id: "a", price_cents: 100000 }),
        listing({ id: "b", price_cents: 400000 }),
      ),
      10,
    );
  });

  it("scores nothing rather than guessing when a price is missing", () => {
    expect(
      priceProximity(listing({ id: "a", price_cents: null }), listing({ id: "b" })),
    ).toBe(0);
  });
});

describe("text similarity", () => {
  it("weights a rare word above a common one", () => {
    const corpus = catalogue();
    const idf = buildIdf(corpus);
    // "Instagram" is on 2 of 5 here; "mural" on 1.
    expect((idf.get("mural") ?? 0)).toBeGreaterThan(idf.get("instagram") ?? 0);
  });

  it("is zero when either side has no usable words", () => {
    expect(textSimilarity([], ["wall"], new Map())).toBe(0);
    expect(textSimilarity(["wall"], [], new Map())).toBe(0);
  });
});

describe("content similarity", () => {
  it("rates two listings on the same channel and city above unrelated ones", () => {
    const corpus = catalogue();
    const idf = buildIdf(corpus);
    const alike = contentSimilarity(corpus[0], corpus[1], idf).score;
    const unalike = contentSimilarity(corpus[0], corpus[4], idf).score;
    expect(alike).toBeGreaterThan(unalike);
  });

  it("explains itself in words a member could read", () => {
    const idf = buildIdf(catalogue());
    const { reasons } = contentSimilarity(catalogue()[0], catalogue()[1], idf);
    expect(reasons).toContain("Also Instagram");
    expect(reasons).toContain("In Berkeley");
  });
});

describe("affinity", () => {
  it("weights a like far above a passing impression", () => {
    const affinity = buildAffinity(
      [
        { listingId: "a", kind: "impression", at: now },
        { listingId: "b", kind: "like", at: now },
      ],
      now,
    );
    expect(affinity.get("b")!).toBeGreaterThan(affinity.get("a")! * 5);
  });

  it("lets old interest fade", () => {
    const affinity = buildAffinity(
      [
        { listingId: "fresh", kind: "click", at: now },
        { listingId: "stale", kind: "click", at: now - 60 * DAY },
      ],
      now,
    );
    expect(affinity.get("fresh")!).toBeGreaterThan(affinity.get("stale")! * 10);
  });

  it("ignores a kind it does not know", () => {
    const affinity = buildAffinity(
      [{ listingId: "a", kind: "wat" as never, at: now }],
      now,
    );
    expect(affinity.size).toBe(0);
  });
});

describe("recommendations", () => {
  it("still returns something for a first-time visitor, and does not call it personalised", () => {
    const result = recommendListings({ candidates: catalogue(), events: [], nowMs: now });
    expect(result.personalised).toBe(false);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("moves toward what the visitor actually looked at", () => {
    const result = recommendListings({
      candidates: catalogue(),
      events: [{ listingId: "wall-1", kind: "like", at: now }],
      nowMs: now,
    });
    expect(result.personalised).toBe(true);
    // Liking the mural should not leave the YouTube read on top.
    expect(result.items[0].listing.id).not.toBe("yt-1");
  });

  it("never recommends a member their own listing", () => {
    const result = recommendListings({
      candidates: catalogue(),
      events: [],
      nowMs: now,
      viewerProfileId: "owner-ig-1",
    });
    expect(result.items.map((entry) => entry.listing.id)).not.toContain("ig-1");
  });

  it("drops demo, blocked, and listings that are not live", () => {
    const candidates = catalogue().concat([
      listing({ id: "demo", owner: { id: "owner-demo", is_demo: true } }),
      listing({ id: "blocked", owner: { id: "owner-blocked", is_demo: false } }),
      listing({ id: "paused", status: "paused", owner: { id: "owner-paused", is_demo: false } }),
    ]);
    const ids = recommendListings({
      candidates,
      events: [],
      nowMs: now,
      blockedProfileIds: new Set(["owner-blocked"]),
    }).items.map((entry) => entry.listing.id);
    expect(ids).not.toContain("demo");
    expect(ids).not.toContain("blocked");
    expect(ids).not.toContain("paused");
  });

  it("shows at most one listing per owner", () => {
    const sameOwner = { id: "prolific", categories: ["Local"], is_demo: false };
    const candidates = [
      listing({ id: "p1", owner: sameOwner }),
      listing({ id: "p2", owner: sameOwner }),
      listing({ id: "p3", owner: sameOwner }),
      listing({ id: "other", owner: { id: "someone-else", is_demo: false } }),
    ];
    const items = recommendListings({ candidates, events: [], nowMs: now }).items;
    const owners = items.map((entry) => entry.listing.owner?.id);
    expect(new Set(owners).size).toBe(owners.length);
  });

  it("does not fill the row with the same channel", () => {
    const candidates = [
      listing({ id: "a", owner: { id: "o-a", is_demo: false } }),
      listing({ id: "b", owner: { id: "o-b", is_demo: false } }),
      listing({ id: "c", owner: { id: "o-c", is_demo: false } }),
      listing({
        id: "different",
        channel: "Vehicle",
        title: "Poster on my rear car window",
        format: "a poster on my rear car window",
        description: "Parked around campus most days.",
        location_area: "Brea, CA",
        owner: { id: "o-d", is_demo: false },
      }),
    ];
    const items = recommendListings({ candidates, events: [], nowMs: now, limit: 4 }).items;
    const channels = items.map((entry) => entry.listing.channel);
    expect(new Set(channels).size).toBeGreaterThan(1);
  });

  it("demotes what they have already opened without hiding it", () => {
    const candidates = catalogue();
    const withHistory = recommendListings({
      candidates,
      events: [{ listingId: "ig-1", kind: "click", at: now }],
      nowMs: now,
    });
    // Still offered somewhere...
    expect(withHistory.items.map((entry) => entry.listing.id)).toContain("ig-1");
    // ...just not as the headline.
    expect(withHistory.items[0].listing.id).not.toBe("ig-1");
  });

  it("returns nothing at all rather than a thin row when there is nothing to show", () => {
    expect(recommendListings({ candidates: [], events: [], nowMs: now }).items).toEqual([]);
  });
});

describe("the collaborative-filtering term", () => {
  const candidates = catalogue();
  const events = [{ listingId: "ig-1" as const, kind: "click" as const, at: now }];

  function scoreOf(index: CooccurrenceIndex | null, id: string) {
    const result = recommendListings({ candidates, events, nowMs: now, cooccurrence: index });
    return result.items.find((entry) => entry.listing.id === id)?.score ?? 0;
  }

  it("contributes nothing on today's data, where no pair has ever co-occurred", () => {
    const empty: CooccurrenceIndex = new Map();
    expect(scoreOf(empty, "yt-1")).toBeCloseTo(scoreOf(null, "yt-1"), 10);
  });

  it("is held back while a pair is still a coincidence", () => {
    const belowFloor: CooccurrenceIndex = new Map([
      ["yt-1", new Map([["ig-1", 1], ["yt-1", 1]])],
      ["ig-1", new Map([["yt-1", 1], ["ig-1", 1]])],
    ]);
    const atFloor: CooccurrenceIndex = new Map([
      ["yt-1", new Map([["ig-1", COOCCURRENCE_CONFIDENCE], ["yt-1", COOCCURRENCE_CONFIDENCE]])],
      ["ig-1", new Map([["yt-1", COOCCURRENCE_CONFIDENCE], ["ig-1", COOCCURRENCE_CONFIDENCE]])],
    ]);
    expect(scoreOf(atFloor, "yt-1")).toBeGreaterThan(scoreOf(belowFloor, "yt-1"));
  });

  it("can carry a listing that content alone would never surface", () => {
    // yt-1 shares no channel, city or price band with ig-1. Only real co-visits
    // can lift it - which is exactly the Amazon behaviour.
    const strong: CooccurrenceIndex = new Map([
      ["yt-1", new Map([["ig-1", 50], ["yt-1", 60]])],
      ["ig-1", new Map([["yt-1", 50], ["ig-1", 60]])],
    ]);
    expect(scoreOf(strong, "yt-1")).toBeGreaterThan(scoreOf(null, "yt-1"));
    const withCf = recommendListings({
      candidates,
      events,
      nowMs: now,
      cooccurrence: strong,
    });
    expect(
      withCf.items.find((entry) => entry.listing.id === "yt-1")?.reasons,
    ).toContain("People who looked at that looked at this");
  });
});

import {
  TASTE_CONFIDENCE,
  buildTasteProfile,
  comparePersonal,
  personalScore,
  tasteConfidence,
  tasteFit,
} from "../lib/listings/recommend";

// The grid is ranked from a taste profile: a share per channel and city built
// from what this browser has opened. These pin the behaviour the founders
// asked for in words - "if they click more Instagram, show more Instagram" -
// and the one invariant that keeps it safe: a stranger sees the grid unchanged.
describe("taste profile", () => {
  it("is a share per channel, so three Instagram clicks and one YouTube is 75/25", () => {
    const taste = buildTasteProfile(
      [
        { listingId: "ig-1", kind: "click", at: now },
        { listingId: "ig-2", kind: "click", at: now },
        { listingId: "ig-1", kind: "impression", at: now - DAY },
        { listingId: "yt-1", kind: "click", at: now },
      ],
      catalogue(),
      now,
    );
    const instagram = taste.channels.get("instagram") ?? 0;
    const youtube = taste.channels.get("youtube") ?? 0;
    expect(instagram).toBeGreaterThan(youtube);
    expect(instagram + youtube).toBeCloseTo(1, 10);
    // Two clicks plus an impression against one click.
    expect(instagram).toBeGreaterThan(0.65);
  });

  it("keeps cities in the picture", () => {
    const taste = buildTasteProfile(
      [{ listingId: "car-1", kind: "click", at: now }],
      catalogue(),
      now,
    );
    expect(taste.cities.get("brea")).toBeCloseTo(1, 10);
    expect(taste.cities.has("berkeley")).toBe(false);
  });

  it("ignores a listing that has left the catalogue rather than guessing its channel", () => {
    const taste = buildTasteProfile(
      [{ listingId: "gone", kind: "like", at: now }],
      catalogue(),
      now,
    );
    expect(taste.strength).toBe(0);
    expect(taste.channels.size).toBe(0);
  });

  it("does not count in full until there is two clicks' worth of interest", () => {
    const glance = buildTasteProfile(
      [{ listingId: "ig-1", kind: "impression", at: now }],
      catalogue(),
      now,
    );
    const settled = buildTasteProfile(
      [
        { listingId: "ig-1", kind: "click", at: now },
        { listingId: "ig-2", kind: "click", at: now },
      ],
      catalogue(),
      now,
    );
    expect(tasteConfidence(glance)).toBeLessThan(0.3);
    expect(tasteConfidence(settled)).toBe(1);
    expect(settled.strength).toBeGreaterThanOrEqual(TASTE_CONFIDENCE);
  });
});

describe("the personal grid order", () => {
  it("scores every listing exactly 0 for a stranger, so the grid falls through to its old order", () => {
    const taste = buildTasteProfile([], catalogue(), now);
    for (const candidate of catalogue()) {
      expect(personalScore(candidate, taste, now)).toBe(0);
    }
    expect(comparePersonal(catalogue()[0], catalogue()[4], taste, now)).toBe(0);
  });

  it("puts the channel they keep opening ahead of the rest", () => {
    const taste = buildTasteProfile(
      [
        { listingId: "ig-1", kind: "click", at: now },
        { listingId: "ig-2", kind: "click", at: now },
      ],
      catalogue(),
      now,
    );
    const order = catalogue()
      .sort((a, b) => comparePersonal(a, b, taste, now))
      .map((entry) => entry.id);
    // Both Instagram listings before the mural, the car and the YouTube read.
    expect(order.indexOf("ig-1")).toBeLessThan(order.indexOf("wall-1"));
    expect(order.indexOf("ig-2")).toBeLessThan(order.indexOf("yt-1"));
  });

  it("gives Kausthubh and Dylan different orders when they open different things", () => {
    const instagramFan = buildTasteProfile(
      [
        { listingId: "ig-1", kind: "click", at: now },
        { listingId: "ig-2", kind: "click", at: now },
      ],
      catalogue(),
      now,
    );
    const videoFan = buildTasteProfile(
      [
        { listingId: "yt-1", kind: "click", at: now },
        { listingId: "yt-1", kind: "like", at: now },
      ],
      catalogue(),
      now,
    );
    const first = catalogue().sort((a, b) => comparePersonal(a, b, instagramFan, now))[0].id;
    const second = catalogue().sort((a, b) => comparePersonal(a, b, videoFan, now))[0].id;
    expect(first).not.toBe(second);
    expect(second).toBe("yt-1");
  });

  it("ranks within a channel by likes and reach, not by accident", () => {
    const taste = buildTasteProfile(
      [{ listingId: "ig-1", kind: "click", at: now }, { listingId: "ig-2", kind: "click", at: now }],
      catalogue(),
      now,
    );
    const quiet = listing({ id: "ig-quiet", like_count: 0 });
    const loved = listing({ id: "ig-loved", like_count: 6, clicks_7d: 9, impressions_7d: 40 });
    expect(personalScore(loved, taste, now)).toBeGreaterThan(personalScore(quiet, taste, now));
  });

  it("leans harder the more lopsided the interest is", () => {
    const mixed = buildTasteProfile(
      [{ listingId: "ig-1", kind: "click", at: now }, { listingId: "yt-1", kind: "click", at: now }],
      catalogue(),
      now,
    );
    const devoted = buildTasteProfile(
      [{ listingId: "ig-1", kind: "click", at: now }, { listingId: "ig-2", kind: "click", at: now }],
      catalogue(),
      now,
    );
    expect(tasteFit(catalogue()[0], devoted)).toBeGreaterThan(tasteFit(catalogue()[0], mixed));
  });

  it("fades, so what they opened a month ago no longer runs the grid", () => {
    const stale = buildTasteProfile(
      [{ listingId: "yt-1", kind: "click", at: now - 45 * DAY }],
      catalogue(),
      now,
    );
    expect(tasteConfidence(stale)).toBeLessThan(0.1);
  });
});

describe("the row and the grid agree", () => {
  it("lets the row lean on channel taste too, not only on resemblance to a seed", () => {
    const events = [
      { listingId: "ig-1" as const, kind: "click" as const, at: now },
      { listingId: "ig-2" as const, kind: "click" as const, at: now },
    ];
    const withTaste = recommendListings({ candidates: catalogue(), events, nowMs: now, limit: 5 });
    const top = withTaste.items[0].listing.id;
    // ig-1 and ig-2 are demoted as already seen; the next Instagram-shaped
    // thing still comes before the YouTube read, because the taste term
    // carries channel interest past the seeds themselves.
    expect(withTaste.items.map((entry) => entry.listing.id).indexOf("yt-1")).toBeGreaterThan(
      withTaste.items.map((entry) => entry.listing.id).indexOf(top),
    );
  });
});

describe("popularity orders within taste, and never overrides it", () => {
  // The case that came out of the live catalogue: somebody who opens walls and
  // a car window, in a town where one Instagram listing is the most looked-at
  // thing on the site. They asked for walls.
  const physical = () =>
    buildTasteProfile(
      [
        { listingId: "wall-1", kind: "click", at: now },
        { listingId: "wall-1", kind: "click", at: now - DAY },
        { listingId: "car-1", kind: "click", at: now },
      ],
      catalogue(),
      now,
    );
  const hotInstagramNextDoor = listing({
    id: "ig-hot",
    like_count: 6,
    clicks_7d: 20,
    impressions_7d: 200,
    created_at: "2026-09-03T12:00:00.000Z",
    owner: { id: "owner-hot", categories: ["Local"], verified: true, is_demo: false },
  });
  const quietWallFarAway = listing({
    id: "wall-quiet",
    title: "Wall or mural in Fresno",
    channel: "Wall / mural",
    format: "6x7 wall or mural for a week",
    description: "A brick wall facing a quiet street, painted or postered.",
    location_area: "Fresno, CA",
    created_at: "2026-06-01T12:00:00.000Z",
    owner: { id: "owner-quiet", categories: ["Art"], is_demo: false },
  });

  it("keeps the channel they keep opening above a hotter listing on one they never open", () => {
    const taste = physical();
    expect(personalScore(quietWallFarAway, taste, now)).toBeGreaterThan(
      personalScore(hotInstagramNextDoor, taste, now),
    );
  });

  it("scores a listing on a channel and in a place they never opened exactly 0, as for a stranger", () => {
    const taste = physical();
    const unknown = listing({ id: "yt-far", channel: "YouTube", location_area: "Fresno, CA" });
    expect(personalScore(unknown, taste, now)).toBe(0);
  });

  it("lets likes and reach decide when interest is split evenly", () => {
    const even = buildTasteProfile(
      [
        { listingId: "ig-1", kind: "click", at: now },
        { listingId: "yt-1", kind: "click", at: now },
      ],
      catalogue(),
      now,
    );
    const lovedVideo = listing({
      id: "yt-loved",
      channel: "YouTube",
      location_area: "Yorba Linda, CA",
      like_count: 6,
      clicks_7d: 9,
      impressions_7d: 40,
    });
    const quietPost = listing({ id: "ig-quiet", like_count: 0 });
    expect(personalScore(lovedVideo, even, now)).toBeGreaterThan(personalScore(quietPost, even, now));
  });
});
