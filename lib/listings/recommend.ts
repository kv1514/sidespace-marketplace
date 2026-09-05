import { popularityScore, normalizeLikeCount } from "./popularity";

/**
 * What to put in front of somebody next.
 *
 * The shape of this problem here is not the shape Amazon has. "Customers who
 * bought this also bought" works because a pair of products has been bought
 * together ten thousand times; SideSpace has 19 active listings, 0 likes and 1
 * request. Item-to-item collaborative filtering on that data returns an empty
 * list for every listing, every time.
 *
 * So the ranking is a blend, and the blend moves on its own:
 *
 *   content   - what this listing IS, against what this person has looked at.
 *               Carries the whole thing on day one.
 *   co-visits - the real item-to-item signal. Contributes exactly nothing
 *               until a PAIR of listings has been seen together often enough
 *               to mean something, then takes over for that pair.
 *   quality   - freshness and completeness, so a good new listing is not
 *               invisible for lack of history.
 *
 * Nothing here has to be switched on later. A pair that has never co-occurred
 * scores zero on the middle term and the other two decide; a pair with real
 * traffic behind it outweighs a channel match. That is the same mechanism
 * Amazon uses, gated so it never invents confidence it has not earned.
 *
 * Pure functions only - no React, no Supabase, no clock of its own. `nowMs` is
 * always passed in so the decay is testable.
 */

export type InteractionKind = "impression" | "click" | "like" | "offer";

export type AffinityEvent = {
  listingId: string;
  kind: InteractionKind;
  /** epoch ms */
  at: number;
};

export type RecommendOwner = {
  id?: string | null;
  categories?: string[] | null;
  verified?: boolean | null;
  is_demo?: boolean | null;
};

export type RecommendListing = {
  id: string;
  owner_profile_id?: string | null;
  title?: string | null;
  channel?: string | null;
  format?: string | null;
  description?: string | null;
  location_area?: string | null;
  price_cents?: number | string | null;
  price_max_cents?: number | string | null;
  status?: string | null;
  like_count?: number | string | null;
  created_at?: string | null;
  owner?: RecommendOwner | null;
};

export type Recommendation<T> = {
  listing: T;
  score: number;
  reasons: string[];
};

/** How much one interaction says about what somebody wants. */
const KIND_WEIGHT: Record<InteractionKind, number> = {
  impression: 1,
  click: 4,
  like: 10,
  offer: 20,
};

/** Interest halves roughly every fortnight, so last month stops steering today. */
const DECAY_DAYS = 14;

/**
 * A pair needs this many co-visits before its co-visit score counts in full.
 * Below it the term is scaled down, so two people happening to open the same
 * two listings cannot manufacture a recommendation.
 */
export const COOCCURRENCE_CONFIDENCE = 5;

const TOP_LEVEL_WEIGHTS = { content: 62, cooccurrence: 40, quality: 18 };

/** Penalty applied to a candidate for resembling something already picked. */
const DIVERSITY_LAMBDA = 0.35;

/** They have already seen it. Worth showing again, but not first. */
const SEEN_DEMOTION = 0.55;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "your", "our", "you", "all", "any", "can", "get",
  "one", "per", "out", "are", "this", "that", "from", "into", "will", "have",
  "has", "its", "their", "them", "they", "who", "how", "what", "when", "where",
  "week", "day", "days", "month", "campaign", "listing", "space", "sidespace",
]);

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function num(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Case-fold and strip punctuation.
 *
 * This is load-bearing, not tidying. `channel` and `profiles.categories` have
 * no database constraint and the live data proves it: `academics` next to
 * `Academic Competition`, `college` next to `College`, `Food` next to `food`.
 * Comparing the raw strings finds almost no matches at all.
 */
export function normalizeTerm(value: unknown) {
  return text(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * `Berkeley, CA` and `Berkeley` are one place. So are `Fullerton, CA` and
 * `Fullerton, CA and online`. The field is free text and every one of those
 * spellings is live right now.
 */
export function normalizeCity(value: unknown) {
  return normalizeTerm(text(value).split(",")[0]);
}

export function tokenize(value: unknown) {
  return normalizeTerm(value)
    .split(" ")
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function listingTokens(listing: RecommendListing) {
  return tokenize(
    `${text(listing.title)} ${text(listing.format)} ${text(listing.description)}`,
  );
}

/**
 * Rare words say more than common ones. With `Instagram` on 6 of 19 listings,
 * an unweighted overlap would call almost everything similar to almost
 * everything.
 */
export function buildIdf(listings: RecommendListing[]) {
  const documentFrequency = new Map<string, number>();
  for (const listing of listings) {
    for (const token of new Set(listingTokens(listing))) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const total = Math.max(1, listings.length);
  const idf = new Map<string, number>();
  for (const [token, frequency] of documentFrequency) {
    idf.set(token, Math.log(1 + total / frequency));
  }
  return idf;
}

/** Cosine over IDF-weighted token sets. 0 when either side has no words. */
export function textSimilarity(
  first: string[],
  second: string[],
  idf: Map<string, number>,
) {
  if (!first.length || !second.length) return 0;
  const left = new Set(first);
  const right = new Set(second);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const token of left) {
    const weight = idf.get(token) ?? 1;
    leftNorm += weight * weight;
    if (right.has(token)) dot += weight * weight;
  }
  for (const token of right) {
    const weight = idf.get(token) ?? 1;
    rightNorm += weight * weight;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function categoriesOf(listing: RecommendListing) {
  const raw = listing.owner?.categories;
  return Array.isArray(raw)
    ? new Set(raw.map(normalizeTerm).filter(Boolean))
    : new Set<string>();
}

function priceOf(listing: RecommendListing) {
  const low = num(listing.price_cents);
  const high = num(listing.price_max_cents);
  if (low && high) return Math.sqrt(low * high);
  return low || high || 0;
}

/**
 * Closeness on a log scale, because $10 against $40 is the same distance as
 * $1,000 against $4,000 - and a budget is felt as a multiple, not a difference.
 */
export function priceProximity(first: RecommendListing, second: RecommendListing) {
  const a = priceOf(first);
  const b = priceOf(second);
  if (!a || !b) return 0;
  const ratio = Math.abs(Math.log(a / b));
  return Math.max(0, 1 - ratio / Math.log(8));
}

/** Internal weights, normalised to 0..1 by the total below. */
const CONTENT_WEIGHTS = {
  channel: 30,
  categories: 24,
  location: 18,
  price: 12,
  words: 25,
};
const CONTENT_TOTAL = Object.values(CONTENT_WEIGHTS).reduce((a, b) => a + b, 0);

/** How alike two listings are, 0..1, with the reasons that made it so. */
export function contentSimilarity(
  first: RecommendListing,
  second: RecommendListing,
  idf: Map<string, number>,
) {
  const reasons: string[] = [];
  let score = 0;

  const channel = normalizeTerm(first.channel);
  if (channel && channel === normalizeTerm(second.channel)) {
    score += CONTENT_WEIGHTS.channel;
    reasons.push(`Also ${text(first.channel)}`);
  }

  const firstCategories = categoriesOf(first);
  const sharedCategories = [...categoriesOf(second)].filter((category) =>
    firstCategories.has(category),
  );
  if (sharedCategories.length) {
    score += Math.min(CONTENT_WEIGHTS.categories, sharedCategories.length * 12);
    reasons.push(`Shares ${sharedCategories.length > 1 ? "interests" : sharedCategories[0]}`);
  }

  const city = normalizeCity(first.location_area);
  const otherCity = normalizeCity(second.location_area);
  if (city && city === otherCity) {
    score += CONTENT_WEIGHTS.location;
    reasons.push(`In ${text(first.location_area).split(",")[0].trim()}`);
  } else if (city && otherCity && (city.startsWith(otherCity) || otherCity.startsWith(city))) {
    score += CONTENT_WEIGHTS.location * 0.55;
    reasons.push("Nearby");
  }

  const price = priceProximity(first, second);
  if (price > 0.5) {
    score += CONTENT_WEIGHTS.price * price;
    reasons.push("Similar budget");
  }

  const words = textSimilarity(listingTokens(first), listingTokens(second), idf);
  if (words > 0.08) {
    score += CONTENT_WEIGHTS.words * words;
    reasons.push("Describes something similar");
  }

  return { score: score / CONTENT_TOTAL, reasons };
}

/**
 * Recency-decayed interest per listing, from this visitor's own history.
 *
 * Lives in the browser and is derived from the same events the analytics spine
 * records, so nothing about one person's browsing has to be read back out of
 * the database to personalise their page.
 */
export function buildAffinity(events: AffinityEvent[], nowMs: number) {
  const affinity = new Map<string, number>();
  for (const event of events) {
    const weight = KIND_WEIGHT[event.kind];
    if (!weight) continue;
    const ageDays = Math.max(0, (nowMs - event.at) / 86_400_000);
    const decayed = weight * Math.exp(-ageDays / DECAY_DAYS);
    affinity.set(event.listingId, (affinity.get(event.listingId) ?? 0) + decayed);
  }
  return affinity;
}

/** listing id -> co-visited listing id -> number of visitors who saw both. */
export type CooccurrenceIndex = Map<string, Map<string, number>>;

function cooccurrenceScore(
  candidateId: string,
  seedId: string,
  index: CooccurrenceIndex | null,
) {
  if (!index) return 0;
  const pairs = index.get(candidateId)?.get(seedId) ?? 0;
  if (!pairs) return 0;
  const candidateTotal = index.get(candidateId)?.get(candidateId) ?? pairs;
  const seedTotal = index.get(seedId)?.get(seedId) ?? pairs;
  const cosine = pairs / Math.sqrt(Math.max(1, candidateTotal) * Math.max(1, seedTotal));
  // Below the floor the pair is a coincidence, not a pattern.
  const confidence = Math.min(1, pairs / COOCCURRENCE_CONFIDENCE);
  return cosine * confidence;
}

export type RecommendInput<T extends RecommendListing> = {
  candidates: T[];
  events: AffinityEvent[];
  nowMs: number;
  /** The viewer's own profile id, so we never recommend them their own listing. */
  viewerProfileId?: string | null;
  blockedProfileIds?: Set<string>;
  cooccurrence?: CooccurrenceIndex | null;
  limit?: number;
};

export type RecommendResult<T extends RecommendListing> = {
  items: Recommendation<T>[];
  /**
   * False when the visitor has no history and the row is really just "popular".
   * The UI must not call it personalised when this is false.
   */
  personalised: boolean;
};

export function recommendListings<T extends RecommendListing>({
  candidates,
  events,
  nowMs,
  viewerProfileId,
  blockedProfileIds,
  cooccurrence = null,
  limit = 6,
}: RecommendInput<T>): RecommendResult<T> {
  const eligible = candidates.filter((listing) => {
    if (listing.status && listing.status !== "active") return false;
    if (listing.owner?.is_demo) return false;
    const ownerId = listing.owner?.id ?? listing.owner_profile_id ?? "";
    if (viewerProfileId && ownerId === viewerProfileId) return false;
    if (ownerId && blockedProfileIds?.has(ownerId)) return false;
    return true;
  });
  if (!eligible.length) return { items: [], personalised: false };

  const idf = buildIdf(candidates);
  const affinity = buildAffinity(events, nowMs);
  const byId = new Map(candidates.map((listing) => [listing.id, listing]));

  // Only seeds still in the catalogue can be compared against.
  const seeds = [...affinity.entries()]
    .filter(([id]) => byId.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  const seedTotal = seeds.reduce((sum, [, weight]) => sum + weight, 0);
  const personalised = seedTotal > 0;

  const scored = eligible.map((listing) => {
    const reasons = new Set<string>();
    let contentTerm = 0;
    let cooccurrenceTerm = 0;

    for (const [seedId, weight] of seeds) {
      if (seedId === listing.id) continue;
      const share = weight / seedTotal;
      const seed = byId.get(seedId);
      if (!seed) continue;

      const similarity = contentSimilarity(listing, seed, idf);
      contentTerm += similarity.score * share;
      if (similarity.score > 0.18) {
        for (const reason of similarity.reasons) reasons.add(reason);
      }

      const covisit = cooccurrenceScore(listing.id, seedId, cooccurrence);
      cooccurrenceTerm += covisit * share;
      if (covisit > 0.2) reasons.add("People who looked at that looked at this");
    }

    // popularityScore has no fixed ceiling; 45 is a comfortable strong score,
    // and clamping keeps the quality prior from swamping a real signal.
    const quality = Math.min(1, popularityScore(listing, nowMs) / 45);
    if (!personalised && normalizeLikeCount(listing.like_count) > 0) {
      reasons.add("Popular right now");
    }

    let score =
      TOP_LEVEL_WEIGHTS.content * contentTerm +
      TOP_LEVEL_WEIGHTS.cooccurrence * cooccurrenceTerm +
      TOP_LEVEL_WEIGHTS.quality * quality;

    // Already seen it: still worth offering, just not first.
    if (affinity.has(listing.id)) score *= SEEN_DEMOTION;

    return { listing, score, reasons: [...reasons].slice(0, 2) };
  });

  return { items: diversify(scored, idf, limit), personalised };
}

/**
 * Greedy maximal-marginal-relevance, plus one listing per owner.
 *
 * Without this the row is six Instagram stories from whoever posted most - the
 * highest-scoring set, and useless, because someone who did not want the first
 * one does not want five more of it. Each pick is penalised by how much it
 * resembles what has already been picked, so the row spreads out.
 */
function diversify<T extends RecommendListing>(
  scored: Recommendation<T>[],
  idf: Map<string, number>,
  limit: number,
) {
  const remaining = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  const picked: Recommendation<T>[] = [];
  const usedOwners = new Set<string>();

  while (picked.length < limit && remaining.length) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const entry = remaining[index];
      const ownerId = entry.listing.owner?.id ?? entry.listing.owner_profile_id ?? "";
      if (ownerId && usedOwners.has(ownerId)) continue;
      let closest = 0;
      for (const chosen of picked) {
        closest = Math.max(
          closest,
          contentSimilarity(entry.listing, chosen.listing, idf).score,
        );
      }
      const value = entry.score - DIVERSITY_LAMBDA * closest * 100;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    if (bestValue === -Infinity) break;
    const [chosen] = remaining.splice(bestIndex, 1);
    const ownerId = chosen.listing.owner?.id ?? chosen.listing.owner_profile_id ?? "";
    if (ownerId) usedOwners.add(ownerId);
    picked.push(chosen);
  }

  return picked;
}
