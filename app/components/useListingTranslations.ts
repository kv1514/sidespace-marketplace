"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Locale } from "@/lib/i18n";
import {
  localizedListingCopy,
  readTranslationFields,
  seedTranslationMap,
  translationKey,
  type ListingTranslationFields,
  type ListingTranslationSeed,
  type TranslatableListing,
} from "@/lib/listings/translations";

/** Listing ids per request. The route accepts a little more; a page rarely shows this many at once. */
const REQUEST_CHUNK = 40;

/**
 * Listings in the reader's language, for a component that shows them.
 *
 * Give it the listings on screen and it hands back `copyFor`, which returns a
 * listing with its prose swapped for the reader's language when a translation
 * exists and the listing itself otherwise. Behind that it keeps one map of
 * translations keyed by language and listing, starts from what the page
 * rendered with, and asks the translations route for whatever the screen
 * needs and the map lacks - once per listing per language, however many
 * times the screen re-renders.
 *
 * English asks for nothing and swaps nothing: the owner's words stand.
 */
export function useListingTranslations<T extends TranslatableListing>({
  locale,
  enabled,
  listings,
  seed,
}: {
  locale: Locale;
  /** False when there is no database behind the page (local preview, demo data). */
  enabled: boolean;
  /** Everything currently on screen, in the order it matters. Memoise it. */
  listings: T[];
  seed?: ListingTranslationSeed | null;
}) {
  const [translations, setTranslations] = useState<Record<string, ListingTranslationFields>>(
    () => seedTranslationMap(seed),
  );
  // Asked for already, whatever the answer was. A listing the route could
  // not translate stays in the owner's language until the next page load
  // rather than being asked for on every render.
  const requested = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled || locale === "en") return;
    const wanted: string[] = [];
    for (const listing of listings) {
      const key = translationKey(locale, listing.id);
      if (translations[key] || requested.current.has(key)) continue;
      requested.current.add(key);
      wanted.push(listing.id);
    }
    if (!wanted.length) return;

    for (let index = 0; index < wanted.length; index += REQUEST_CHUNK) {
      const listingIds = wanted.slice(index, index + REQUEST_CHUNK);
      void fetch("/api/listings/translations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale, listingIds }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: { translations?: unknown } | null) => {
          const byId = payload?.translations;
          if (!byId || typeof byId !== "object") return;
          setTranslations((current) => {
            const next = { ...current };
            for (const [listingId, fields] of Object.entries(byId as Record<string, unknown>)) {
              const read = readTranslationFields(fields);
              if (read) next[translationKey(locale, listingId)] = read;
            }
            return next;
          });
        })
        .catch(() => {
          // The original copy is on the screen; there is nothing useful to
          // tell the reader.
        });
    }
  }, [enabled, listings, locale, translations]);

  const translationFor = useCallback(
    (listing: TranslatableListing): ListingTranslationFields | undefined =>
      locale === "en" ? undefined : translations[translationKey(locale, listing.id)],
    [locale, translations],
  );

  const copyFor = useCallback(
    <L extends TranslatableListing>(listing: L): L & { translated?: boolean } =>
      locale === "en" ? listing : localizedListingCopy(listing, translationFor(listing)),
    [locale, translationFor],
  );

  return useMemo(() => ({ copyFor, translationFor }), [copyFor, translationFor]);
}
