import { parseLocale } from "@/lib/i18n";
import { createAdminClient } from "@/lib/supabase/admin";
import { createPublicClient } from "@/lib/supabase/public";
import {
  LISTING_TRANSLATION_FIELDS,
  translatableText,
  type ListingTranslationFields,
  type TranslatableListing,
} from "@/lib/listings/translations";
import {
  LISTING_TRANSLATION_COLUMNS,
  LISTING_TRANSLATIONS_TABLE,
  freshTranslations,
  listingSourceHash,
  pickTranslationProvider,
  translateListings,
} from "@/lib/listings/translate-server";

/**
 * Where the browser asks for listings in the reader's language.
 *
 * POST { locale, listingIds } and get back { translations: { [id]: fields } }
 * for every listing that could be served. The cache in `listing_translations`
 * answers first; only listings with no fresh row go to the model, and what
 * comes back is cached for the next reader. So each listing is translated
 * once per language per edit, whoever asks, and a page that has been read in
 * Spanish before costs nothing to read in Spanish again.
 *
 * What may be translated is decided by the listings policy, not here: the
 * listings are read with the public key, so a listing a visitor cannot see is
 * one the model never sees either. Owners see their originals, so nothing is
 * ever translated *for* an owner; a reader can only get translations of
 * listings that are already public.
 *
 * Failure is quiet. The listing is still on the screen in the owner's
 * language, and there is nothing to tell the reader that would help them;
 * the answer is simply shorter, and the log line says why.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Several parallel model calls for a cold page; well inside this. */
export const maxDuration = 60;

/** One page of listings. The browser asks in chunks below this. */
const MAX_IDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reply(translations: Record<string, ListingTranslationFields>, status = 200) {
  return Response.json({ translations }, { status, headers: { "Cache-Control": "no-store" } });
}

function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && UUID.test(entry)) ids.add(entry);
    if (ids.size >= MAX_IDS) break;
  }
  return [...ids];
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) return reply({}, 403);

    const body = (await request.json().catch(() => null)) as
      | { locale?: unknown; listingIds?: unknown }
      | null;
    const locale = parseLocale(body?.locale);
    if (!locale || locale === "en") return reply({}, 400);
    const ids = readIds(body?.listingIds);
    if (!ids.length) return reply({});

    const startedAt = Date.now();

    // The listings as the public sees them. Through the anon key the listings
    // policy hides what a visitor may not read, and a hidden listing is one
    // this route does not know exists.
    const publicClient = createPublicClient();
    const { data: rows, error: listingsError } = await publicClient
      .from("listings")
      .select(`id,${LISTING_TRANSLATION_FIELDS.join(",")}`)
      .in("id", ids)
      .eq("status", "active");
    if (listingsError) {
      console.error("[listing translations] listings read failed:", listingsError);
      return reply({});
    }
    // The typed query parser cannot read a column list built from the field
    // array; the rows are the eight prose fields and the id, nothing else.
    const listings = ((rows ?? []) as unknown as TranslatableListing[]).filter(
      (listing) => Object.keys(translatableText(listing)).length > 0,
    );
    if (!listings.length) return reply({});

    // The cache is read through whichever client this deployment has. A
    // deployment without the service key (a preview, typically) still reads
    // what production cached, and still translates; it just cannot cache
    // what it translated, and the log says so.
    let admin: ReturnType<typeof createAdminClient> | null = null;
    try {
      admin = createAdminClient();
    } catch {
      console.error(
        "[listing translations] SUPABASE_SERVICE_ROLE_KEY is not set on this deployment; translations are served but not cached",
      );
    }
    const { data: cached, error: cacheError } = await (admin ?? publicClient)
      .from(LISTING_TRANSLATIONS_TABLE)
      .select(LISTING_TRANSLATION_COLUMNS)
      .eq("locale", locale)
      .in(
        "listing_id",
        listings.map((listing) => listing.id),
      );
    if (cacheError) {
      console.error("[listing translations] cache read failed:", cacheError);
    }
    const translations = freshTranslations(cached, listings);
    const pending = listings.filter((listing) => !translations[listing.id]);
    if (!pending.length) return reply(translations);

    const chosen = pickTranslationProvider();
    if (!chosen) {
      console.error(
        "[listing translations] no provider key is set; listings stay in the owner's language",
      );
      return reply(translations);
    }

    const fresh = await translateListings(
      chosen,
      locale,
      pending.map((listing) => ({ id: listing.id, fields: translatableText(listing) })),
    );
    const upserts = [];
    for (const listing of pending) {
      const fields = fresh[listing.id];
      if (!fields) continue;
      translations[listing.id] = fields;
      upserts.push({
        listing_id: listing.id,
        locale,
        source_hash: listingSourceHash(listing),
        fields,
        translated_at: new Date().toISOString(),
      });
    }
    if (upserts.length && admin) {
      const { error: writeError } = await admin
        .from(LISTING_TRANSLATIONS_TABLE)
        .upsert(upserts, { onConflict: "listing_id,locale" });
      // The reader still gets this answer; only the next reader pays again.
      if (writeError) console.error("[listing translations] cache write failed:", writeError);
    }
    console.info(
      `[listing translations] ok provider=${chosen.provider} locale=${locale} asked=${ids.length} cached=${listings.length - pending.length} translated=${upserts.length} cached_now=${admin ? "yes" : "no"} missed=${pending.length - upserts.length} ms=${Date.now() - startedAt}`,
    );
    return reply(translations);
  } catch (error) {
    console.error("[listing translations] request failed:", error);
    return reply({});
  }
}
