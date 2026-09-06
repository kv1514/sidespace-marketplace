import type { Locale } from "@/lib/i18n";

/**
 * A listing in the reader's language.
 *
 * The interface speaks six languages; until now the posts did not. A visitor
 * who chose Spanish read Spanish menus around English listings, which is the
 * worse half of the job left undone: the copy that decides whether they book
 * is the copy they could not read.
 *
 * Owners write in one language and never see any of this. What they wrote is
 * the record. A translation is a reading aid for someone else, produced on
 * demand by the model behind "Fill with AI", cached per listing and language
 * in `listing_translations`, and ignored the moment the owner edits the
 * original: the cache row carries a digest of the text it was made from, and
 * a digest that no longer matches means the words are no longer the owner's.
 * Nothing is ever written back to `listings`.
 *
 * This is the pure half - the field list, the types, and the merge - so the
 * browser can use it. The digest, the cache read and the model call live in
 * ./translate-server.ts.
 */

/**
 * The copy a listing shows, in the order it is hashed. Everything a reader
 * sees as prose; nothing structured. Channel, price, unit, location, surface
 * types and dates are localised by the interface, not translated by a model.
 */
export const LISTING_TRANSLATION_FIELDS = [
  "title",
  "format",
  "description",
  "demographics",
  "deliverables",
  "availability_notes",
  "minimum_booking",
  "cancellation_policy",
] as const;

export type ListingTranslationField = (typeof LISTING_TRANSLATION_FIELDS)[number];

/** Translated text by field. A field the owner left empty is absent. */
export type ListingTranslationFields = Partial<Record<ListingTranslationField, string>>;

/** Whatever type carries a listing, as far as translation cares. */
export type TranslatableListing = { id: string } & {
  [Field in ListingTranslationField]?: string | null;
};

/** What a page hands the browser: the translations it already had for the reader's language. */
export type ListingTranslationSeed = {
  locale: Locale;
  byId: Record<string, ListingTranslationFields>;
};

/** Longest translation kept for one field. Descriptions run a few hundred words; nothing honest needs more. */
export const MAX_TRANSLATION_LENGTH = 4000;

/**
 * The original text worth translating: trimmed, only the fields that hold
 * anything. An empty field never reaches the model, so it can never come back
 * with words the owner did not write.
 */
export function translatableText(listing: TranslatableListing): ListingTranslationFields {
  const out: ListingTranslationFields = {};
  for (const field of LISTING_TRANSLATION_FIELDS) {
    const value = listing[field];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text) out[field] = text;
  }
  return out;
}

/**
 * What a cache row or a model answer may contain: strings, in the known
 * fields, non-empty, bounded. A bad field is dropped on its own rather than
 * failing the row, so one bad field costs one field.
 */
export function readTranslationFields(value: unknown): ListingTranslationFields | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const out: ListingTranslationFields = {};
  for (const field of LISTING_TRANSLATION_FIELDS) {
    const text = record[field];
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_TRANSLATION_LENGTH) continue;
    out[field] = trimmed;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The listing as the reader should see it. A field is replaced only when the
 * owner wrote something there and the translation has something too; empty
 * stays empty, and a translation identical to the original changes nothing.
 * `translated` says whether anything did change, so the detail view can say
 * so and offer the original.
 */
export function localizedListingCopy<T extends TranslatableListing>(
  listing: T,
  fields: ListingTranslationFields | null | undefined,
): T & { translated: boolean } {
  const copy = { ...listing, translated: false };
  if (!fields) return copy;
  const record = copy as Record<string, unknown>;
  for (const field of LISTING_TRANSLATION_FIELDS) {
    const original = listing[field];
    const replacement = fields[field];
    if (typeof original !== "string" || !original.trim() || !replacement) continue;
    if (replacement === original.trim()) continue;
    record[field] = replacement;
    copy.translated = true;
  }
  return copy;
}

/** How the browser files translations: one map, keyed by language and listing. */
export function translationKey(locale: Locale, listingId: string) {
  return `${locale}:${listingId}`;
}

/** The seed a page rendered with, filed under the same keys the browser uses. */
export function seedTranslationMap(
  seed: ListingTranslationSeed | null | undefined,
): Record<string, ListingTranslationFields> {
  const out: Record<string, ListingTranslationFields> = {};
  if (!seed || seed.locale === "en" || !seed.byId || typeof seed.byId !== "object") return out;
  for (const [listingId, fields] of Object.entries(seed.byId)) {
    const read = readTranslationFields(fields);
    if (read) out[translationKey(seed.locale, listingId)] = read;
  }
  return out;
}
