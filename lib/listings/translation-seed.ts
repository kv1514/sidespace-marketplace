import "server-only";

import { getRequestLocale } from "@/lib/i18n-server";
import { createPublicClient } from "@/lib/supabase/public";
import { loadListingTranslations } from "./translate-server";
import type { ListingTranslationSeed, TranslatableListing } from "./translations";

/**
 * The translations a page can render with straight away.
 *
 * A page that already fetched its listings asks the cache for their
 * translations in the reader's language, so a returning language's listings
 * arrive translated in the HTML rather than flashing English first. Only what
 * is cached and still fresh; anything missing is asked for by the browser
 * after the page is up, and cached for the next reader.
 *
 * Best-effort throughout, like the like counts: a failure here costs the
 * seed, never the page.
 */
export async function loadListingTranslationSeed(
  listings: unknown,
): Promise<ListingTranslationSeed | null> {
  try {
    const locale = await getRequestLocale();
    if (locale === "en" || !Array.isArray(listings) || !listings.length) return null;
    const rows = listings.filter(
      (listing): listing is TranslatableListing =>
        Boolean(listing) &&
        typeof listing === "object" &&
        typeof (listing as { id?: unknown }).id === "string",
    );
    if (!rows.length) return null;
    const byId = await loadListingTranslations(createPublicClient(), locale, rows);
    return { locale, byId };
  } catch (error) {
    console.error("[listing translations] seed failed:", error);
    return null;
  }
}
