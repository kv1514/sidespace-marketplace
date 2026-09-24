import { normalizeLocation } from "./location";

/**
 * How well a listing answers what somebody typed.
 *
 * The marketplace had no answer to this at all. A search was a filter and
 * nothing else: `text.includes(query)` over the title, format, description,
 * channel, city and owner glued into one string, and every row that matched
 * anywhere came back equal, to be ordered by whatever the browsing model
 * thought. So typing "wall" put a listing whose *description* mentioned a wall
 * above the listing actually called "Room 114 - wall or mural", because the
 * second one happened to be less fresh.
 *
 * A search is the strongest statement of intent anyone makes on the page -
 * stronger than anything inferred from what they scrolled past - so where the
 * words land now decides the order, and the browsing model only breaks ties.
 *
 * Scores are a small ladder rather than a tuned blend: the difference between
 * "this is the thing you named" and "this mentions it in passing" is a
 * difference in kind, and a weighted sum of term frequencies would let three
 * passing mentions outrank one title.
 */

/** A listing's searchable text, field by field, so where a word lands matters. */
export type SearchableListing = {
  title?: string | null;
  channel?: string | null;
  format?: string | null;
  description?: string | null;
  location_area?: string | null;
  demographics?: string | null;
  owner?: {
    display_name?: string | null;
    city?: string | null;
    categories?: string[] | null;
  } | null;
};

export const TITLE_EXACT = 100;
export const TITLE_PREFIX = 70;
export const TITLE_PHRASE = 55;
export const CHANNEL_EXACT = 45;
export const TITLE_ALL_WORDS = 40;
export const FORMAT_PHRASE = 25;
export const OWNER_PHRASE = 18;
export const PLACE_PHRASE = 14;
export const BODY_PHRASE = 8;
export const TITLE_SOME_WORDS = 6;

export function normalizeQuery(value: string) {
  return normalizeLocation(value).replace(/\s+/g, " ");
}

function words(value: string) {
  return value.split(/[^a-z0-9]+/i).filter(Boolean);
}

function field(value: unknown) {
  return typeof value === "string" ? normalizeQuery(value) : "";
}

/**
 * 0 when nothing was typed, so a caller can fall through to its own order and
 * an untouched marketplace behaves exactly as it did before.
 */
export function searchRelevance(listing: SearchableListing, query: string) {
  const needle = normalizeQuery(query ?? "");
  if (!needle) return 0;

  const title = field(listing.title);
  const channel = field(listing.channel);
  const format = field(listing.format);
  const description = field(listing.description);
  const place = [field(listing.location_area), field(listing.owner?.city)].join(" ");
  const owner = field(listing.owner?.display_name);
  const categories = Array.isArray(listing.owner?.categories)
    ? listing.owner.categories.map((entry) => field(entry)).join(" ")
    : "";
  const body = [description, field(listing.demographics), categories].join(" ");

  // The ladder, highest rung first. A listing scores its best rung only - the
  // rungs are kinds of match, not points to accumulate.
  if (title === needle) return TITLE_EXACT;
  if (title.startsWith(needle)) return TITLE_PREFIX;
  if (title.includes(needle)) return TITLE_PHRASE;
  if (channel === needle || channel.includes(needle)) return CHANNEL_EXACT;

  const needleWords = words(needle);
  if (needleWords.length > 1) {
    const titleWords = new Set(words(title));
    const matched = needleWords.filter((word) => titleWords.has(word)).length;
    if (matched === needleWords.length) return TITLE_ALL_WORDS;
    if (matched) return TITLE_SOME_WORDS * matched;
  }

  if (format.includes(needle)) return FORMAT_PHRASE;
  if (owner.includes(needle)) return OWNER_PHRASE;
  if (place.includes(needle)) return PLACE_PHRASE;
  if (body.includes(needle)) return BODY_PHRASE;
  return 0;
}

/**
 * Sort comparator: what they asked for first. Ties return 0 so the caller's
 * own tie-break still decides, and an empty query ties everything.
 */
export function compareSearchRelevance(
  first: SearchableListing,
  second: SearchableListing,
  query: string,
) {
  return searchRelevance(second, query) - searchRelevance(first, query);
}
