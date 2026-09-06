import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { LOCALES, type Locale } from "@/lib/i18n";
import {
  LISTING_TRANSLATION_FIELDS,
  readTranslationFields,
  translatableText,
  type ListingTranslationFields,
  type TranslatableListing,
} from "./translations";

/**
 * The server half of listing translation: the digest that ties a cached
 * translation to the text it was made from, the cache read, and the model
 * call. See ./translations.ts for what this is and why the original is never
 * touched.
 *
 * Two providers, chosen by which key the deployment has, exactly as "Fill
 * with AI" does in app/api/listings/draft/route.ts: ANTHROPIC_API_KEY wins,
 * GEMINI_API_KEY is the fallback. Same plain-fetch calls, same structured
 * JSON output, so a listing comes back field for field and never as prose
 * that has to be parsed.
 */

export const LISTING_TRANSLATIONS_TABLE = "listing_translations";
export const LISTING_TRANSLATION_COLUMNS = "listing_id,source_hash,fields";

/** Listings per model call. Small enough to finish in seconds, large enough that a page needs a handful of calls. */
export const TRANSLATION_BATCH_SIZE = 6;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-5";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-3.7-flash";

/** What to call each language in the prompt. Falls back to the switcher's label for a language added later. */
const LANGUAGE_NAMES: Partial<Record<Locale, string>> = {
  es: "Spanish",
  fr: "French",
  zh: "Simplified Chinese (Mandarin, as written in mainland China)",
  ko: "Korean",
  vi: "Vietnamese",
};

export function languageName(locale: Locale) {
  return (
    LANGUAGE_NAMES[locale] ??
    LOCALES.find((item) => item.code === locale)?.label ??
    locale
  );
}

/**
 * A digest of the text a translation was made from. Fields in a fixed order,
 * trimmed, each on its own labelled line so that moving text between fields
 * changes the digest. Compared, never decoded: the row is fresh exactly when
 * the digests match.
 */
export function listingSourceHash(listing: TranslatableListing): string {
  const source = translatableText(listing);
  const canonical = LISTING_TRANSLATION_FIELDS.map(
    (field) => `${field}=${JSON.stringify(source[field] ?? "")}`,
  ).join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The cached translations still true to their listings, keyed by listing id.
 * A row whose digest no longer matches is left out as if it did not exist; so
 * is a row whose fields do not read as translations.
 */
export function freshTranslations(
  rows: unknown,
  listings: TranslatableListing[],
): Record<string, ListingTranslationFields> {
  const out: Record<string, ListingTranslationFields> = {};
  if (!Array.isArray(rows)) return out;
  const digests = new Map(listings.map((listing) => [listing.id, listingSourceHash(listing)]));
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { listing_id, source_hash, fields } = row as Record<string, unknown>;
    if (typeof listing_id !== "string" || typeof source_hash !== "string") continue;
    if (digests.get(listing_id) !== source_hash) continue;
    const read = readTranslationFields(fields);
    if (read) out[listing_id] = read;
  }
  return out;
}

/**
 * The translations the cache already holds for these listings in this
 * language. Read with whatever client the caller has: through the anon key
 * the table's policy shows a translation exactly when the listing is visible.
 * A failed read is an empty result - the listing still renders in the
 * owner's language, and the browser asks again.
 */
export async function loadListingTranslations(
  client: SupabaseClient,
  locale: Locale,
  listings: TranslatableListing[],
): Promise<Record<string, ListingTranslationFields>> {
  if (locale === "en" || !listings.length) return {};
  const { data, error } = await client
    .from(LISTING_TRANSLATIONS_TABLE)
    .select(LISTING_TRANSLATION_COLUMNS)
    .eq("locale", locale)
    .in(
      "listing_id",
      listings.map((listing) => listing.id),
    );
  if (error) {
    console.error("[listing translations] cache read failed:", error);
    return {};
  }
  return freshTranslations(data, listings);
}

/* ------------------------------------------------------------- the model */

export type TranslationProvider = { provider: "anthropic" | "gemini"; apiKey: string };

export function pickTranslationProvider(): TranslationProvider | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.GEMINI_API_KEY) {
    return { provider: "gemini", apiKey: process.env.GEMINI_API_KEY };
  }
  return null;
}

export type TranslationJob = { id: string; fields: ListingTranslationFields };

/** What the model must hand back: every listing it was given, field for field. */
export const LISTING_TRANSLATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["listings"],
  properties: {
    listings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", ...LISTING_TRANSLATION_FIELDS],
        properties: {
          id: { type: "string" },
          ...Object.fromEntries(
            LISTING_TRANSLATION_FIELDS.map((field) => [field, { type: "string" }]),
          ),
        },
      },
    },
  },
} as const;

export function translationSystemPrompt(locale: Locale) {
  const language = languageName(locale);
  return [
    `You translate marketplace listings for SideSpace, where local businesses rent everyday advertising space - a shop window, a wall, a vehicle, a community board, a creator's Instagram post, a team's jersey - from the people who own it. Each listing was written by its owner. Translate it into ${language} so a reader of that language understands exactly what the owner wrote.`,
    "",
    "Rules:",
    `- Faithful and natural. Say what the owner said, the way a fluent native writer of ${language} would put it. Do not add, remove, soften, or embellish anything. Do not answer questions or fill gaps; translate what is there.`,
    "- Keep the owner's voice (usually first person) and register. A short, plain original stays short and plain.",
    "- Never translate or alter: brand and product names, social handles, URLs, email addresses, hashtags, place names and street addresses, people's names, numbers, prices, currencies, dates, times, measurements and their units, and platform names such as Instagram, TikTok, YouTube. SideSpace stays SideSpace.",
    `- "format" completes the sentence "You get ..." on the listing card (for example "one letter-size poster in my front window for a week"). Translate it as the fragment that would complete the equivalent phrase in ${language}, not as a full sentence.`,
    `- Keep line breaks and list structure. Use the punctuation and quotation conventions of ${language}.`,
    "- Each listing keeps its id. Return every field you were given, translated; return an empty string for a field you were not given.",
    "",
    "Reply with the JSON object only.",
  ].join("\n");
}

function translationUserText(jobs: TranslationJob[]) {
  return (
    "Listings to translate, as JSON:\n" +
    JSON.stringify({ listings: jobs.map((job) => ({ id: job.id, ...job.fields })) })
  );
}

/**
 * What the model said, kept only where it can be trusted: a listing that was
 * in the batch, a field the owner actually wrote, text that reads as a
 * translation. Everything else is dropped without failing the batch.
 */
export function readTranslationAnswer(
  text: string,
  jobs: TranslationJob[],
): Record<string, ListingTranslationFields> {
  const out: Record<string, ListingTranslationFields> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  const listings =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { listings?: unknown }).listings)
      ? (parsed as { listings: unknown[] }).listings
      : [];
  const byId = new Map(jobs.map((job) => [job.id, job.fields]));
  for (const item of listings) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const source = byId.get(id);
    if (!source) continue;
    const read = readTranslationFields(item);
    if (!read) continue;
    const fields: ListingTranslationFields = {};
    for (const field of LISTING_TRANSLATION_FIELDS) {
      if (source[field] && read[field]) fields[field] = read[field];
    }
    if (Object.keys(fields).length) out[id] = fields;
  }
  return out;
}

type AnthropicResponse = {
  stop_reason?: string;
  content?: Array<{ type: string; text?: string }>;
  error?: { type?: string; message?: string };
};

async function anthropicTranslate(
  apiKey: string,
  locale: Locale,
  jobs: TranslationJob[],
  withEffort: boolean,
): Promise<{ status: number; text: string; error?: unknown }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  // Identity-linked keys need the workspace named; workspace-scoped keys do
  // not. Same rule as the draft route.
  if (process.env.ANTHROPIC_WORKSPACE_ID) {
    headers["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
  }
  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: process.env.ANTHROPIC_TRANSLATION_MODEL || ANTHROPIC_MODEL,
      max_tokens: 12000,
      system: translationSystemPrompt(locale),
      messages: [
        { role: "user", content: [{ type: "text", text: translationUserText(jobs) }] },
      ],
      output_config: {
        // Translation is not a reasoning task; thinking hard about it only
        // makes the reader wait.
        ...(withEffort ? { effort: "low" } : {}),
        format: { type: "json_schema", schema: LISTING_TRANSLATION_SCHEMA },
      },
    }),
  });
  const json = (await response.json().catch(() => ({}))) as AnthropicResponse;
  const text = json.content?.find((block) => block.type === "text")?.text ?? "";
  return { status: response.status, text, error: json.error ?? json.stop_reason };
}

type GeminiResponse = {
  status?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { code?: number; message?: string; status?: string };
};

async function geminiTranslate(
  apiKey: string,
  locale: Locale,
  jobs: TranslationJob[],
): Promise<{ status: number; text: string; error?: unknown }> {
  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      system_instruction: translationSystemPrompt(locale),
      input: [{ type: "text", text: translationUserText(jobs) }],
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: LISTING_TRANSLATION_SCHEMA,
      },
      generation_config: { thinking_level: "low" },
    }),
  });
  const json = (await response.json().catch(() => ({}))) as GeminiResponse;
  const text =
    json.steps
      ?.filter((step) => step.type === "model_output")
      .flatMap((step) => step.content ?? [])
      .find((part) => part.type === "text" && part.text)?.text ?? "";
  return { status: response.status, text, error: json.error };
}

/** One batch, one provider call. A failure is logged and costs this batch only. */
async function translateBatch(
  chosen: TranslationProvider,
  locale: Locale,
  jobs: TranslationJob[],
): Promise<Record<string, ListingTranslationFields>> {
  try {
    let result =
      chosen.provider === "anthropic"
        ? await anthropicTranslate(chosen.apiKey, locale, jobs, true)
        : await geminiTranslate(chosen.apiKey, locale, jobs);
    // A model that does not take the effort setting says so with a 400; the
    // batch is worth one more try without it.
    if (
      chosen.provider === "anthropic" &&
      result.status === 400 &&
      /effort/i.test(JSON.stringify(result.error ?? ""))
    ) {
      result = await anthropicTranslate(chosen.apiKey, locale, jobs, false);
    }
    if (result.status !== 200 || !result.text) {
      console.error(
        `[listing translations] ${chosen.provider} returned`,
        result.status,
        result.error,
      );
      return {};
    }
    return readTranslationAnswer(result.text, jobs);
  } catch (error) {
    console.error(`[listing translations] ${chosen.provider} call failed:`, error);
    return {};
  }
}

/**
 * Translate these listings into this language, a few per model call, calls
 * in parallel. Returns whatever came back well-formed; a listing missing from
 * the result simply stays in the owner's language for now.
 */
export async function translateListings(
  chosen: TranslationProvider,
  locale: Locale,
  jobs: TranslationJob[],
): Promise<Record<string, ListingTranslationFields>> {
  const batches: TranslationJob[][] = [];
  for (let index = 0; index < jobs.length; index += TRANSLATION_BATCH_SIZE) {
    batches.push(jobs.slice(index, index + TRANSLATION_BATCH_SIZE));
  }
  const results = await Promise.all(
    batches.map((batch) => translateBatch(chosen, locale, batch)),
  );
  return Object.assign({}, ...results) as Record<string, ListingTranslationFields>;
}
