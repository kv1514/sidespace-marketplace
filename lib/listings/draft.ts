/**
 * The shape "Fill with AI" hands back to the listing editor.
 *
 * Shared by the route that asks the model for it and the form that pours it into
 * the inputs, so the two cannot drift. Everything here is a suggestion the
 * member edits before publishing - nothing is written to the database from
 * this module.
 */

/**
 * Mirrors LISTING_CHANNELS in app/MarketplaceApp.tsx. Duplicated on purpose:
 * that file is a client component and cannot be imported by a server route
 * without dragging the whole marketplace along. Keep the two lists identical.
 */
export const DRAFT_CHANNELS = [
  "Instagram",
  "TikTok",
  "YouTube",
  "Newsletter",
  "Website",
  "Storefront",
  "Vehicle",
  "Wall / mural",
  "Room / interior",
  "Community board",
  "Sponsorship",
  "Other",
] as const;

/** Mirrors SURFACE_CHIPS, minus the free-text "Something else" option. */
export const DRAFT_SURFACES = [
  "Posters",
  "Vinyl decals",
  "Counter cards",
  "Flyers",
  "Banners",
  "A-frame signs",
  "Paint or mural",
  "Digital screens",
] as const;

export const DRAFT_INSTALL = ["owner", "renter", "either"] as const;

/** Mirrors PRICE_UNIT_OPTIONS. */
export const DRAFT_PRICE_UNITS = [
  "campaign",
  "day",
  "week",
  "month",
  "post",
  "video",
  "story",
  "mention",
  "sponsor",
  "partner",
] as const;

export type ListingDraftKind = "physical" | "social" | "sponsorship";

export type ListingDraft = {
  title: string;
  channel: (typeof DRAFT_CHANNELS)[number];
  format: string;
  description: string;
  demographics: string;
  location_area: string;
  space_size: string;
  surface_types: Array<(typeof DRAFT_SURFACES)[number]>;
  install_by: (typeof DRAFT_INSTALL)[number] | "";
  /** null when the owner never said - the form leaves the field empty. */
  price_dollars: number | null;
  price_unit: (typeof DRAFT_PRICE_UNITS)[number];
  minimum_booking: string;
  availability_notes: string;
  deliverables: string;
  /** What the model still needs before it can fill the blanks. Empty when nothing is missing. */
  questions: string[];
};

/**
 * What the model is asked to return. Kept to the JSON Schema subset that
 * structured-output APIs guarantee (types, enums, required, no extra keys).
 * Length and range limits are enforced in normalizeListingDraft instead of
 * the schema, so an unsupported keyword can never turn into a rejected
 * request.
 */
export const LISTING_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "channel",
    "format",
    "description",
    "demographics",
    "location_area",
    "space_size",
    "surface_types",
    "install_by",
    "price_dollars",
    "price_unit",
    "minimum_booking",
    "availability_notes",
    "deliverables",
    "questions",
  ],
  properties: {
    title: { type: "string" },
    channel: { type: "string", enum: [...DRAFT_CHANNELS] },
    format: { type: "string" },
    description: { type: "string" },
    demographics: { type: "string" },
    location_area: { type: "string" },
    space_size: { type: "string" },
    surface_types: { type: "array", items: { type: "string", enum: [...DRAFT_SURFACES] } },
    install_by: {
      type: "string",
      description: "owner, renter, either, or an empty string when unknown",
    },
    price_dollars: { anyOf: [{ type: "integer" }, { type: "null" }] },
    price_unit: { type: "string", enum: [...DRAFT_PRICE_UNITS] },
    minimum_booking: { type: "string" },
    availability_notes: { type: "string" },
    deliverables: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
  },
} as const;

const TITLE_MAX = 120;
const FORMAT_MAX = 140;
const SPACE_SIZE_MAX = 80;
const LONG_MAX = 2000;
const PRICE_MIN = 2;
const PRICE_MAX = 100_000;
const QUESTIONS_MAX = 5;

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function oneOf<T extends readonly string[]>(
  value: unknown,
  options: T,
  fallback: T[number],
): T[number] {
  return typeof value === "string" && (options as readonly string[]).includes(value)
    ? (value as T[number])
    : fallback;
}

/**
 * Turn whatever came back into a draft the form can trust. Model output is
 * treated like any other untrusted input: clamped, filtered, defaulted.
 */
export function normalizeListingDraft(
  input: unknown,
  kind: ListingDraftKind,
): ListingDraft | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;

  const title = text(raw.title, TITLE_MAX);
  const format = text(raw.format, FORMAT_MAX);
  const description = text(raw.description, LONG_MAX);
  // A blank is the model declining to invent, which is the point. The first
  // live draft was thrown away for an empty offer line the owner had never
  // stated; only a draft with nothing in it at all is unusable.
  if (!title && !format && !description) return null;

  const defaultChannel =
    kind === "physical" ? "Storefront" : kind === "sponsorship" ? "Sponsorship" : "Instagram";
  const price = Number(raw.price_dollars);
  const statedPrice =
    raw.price_dollars === null || !Number.isFinite(price) || price <= 0
      ? null
      : Math.round(price);
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .map((item) => text(item, 200))
    .filter(Boolean);
  // The site's floor is $2. A stated $1 must not turn into $2 silently - the
  // first live draft did exactly that. Keep the floor, and say so.
  if (statedPrice !== null && statedPrice < PRICE_MIN) {
    questions.unshift(
      `You said $${statedPrice}. The lowest price SideSpace accepts is $${PRICE_MIN}, so the draft uses $${PRICE_MIN} - is that OK, or would you rather change it?`,
    );
  }
  const surfaces = Array.isArray(raw.surface_types)
    ? raw.surface_types.filter(
        (item): item is (typeof DRAFT_SURFACES)[number] =>
          typeof item === "string" &&
          (DRAFT_SURFACES as readonly string[]).includes(item),
      )
    : [];

  return {
    title,
    channel: oneOf(raw.channel, DRAFT_CHANNELS, defaultChannel),
    format,
    description,
    demographics: text(raw.demographics, 240),
    location_area: text(raw.location_area, 120),
    space_size: text(raw.space_size, SPACE_SIZE_MAX),
    surface_types: Array.from(new Set(surfaces)),
    install_by: oneOf(raw.install_by, [...DRAFT_INSTALL, ""] as const, ""),
    // No default price. A number the owner never said is exactly the kind of
    // guess this feature must not make; the form leaves it empty and asks.
    price_dollars: statedPrice === null ? null : Math.min(PRICE_MAX, Math.max(PRICE_MIN, statedPrice)),
    price_unit: oneOf(
      raw.price_unit,
      DRAFT_PRICE_UNITS,
      kind === "physical" ? "week" : kind === "sponsorship" ? "campaign" : "post",
    ),
    minimum_booking: text(raw.minimum_booking, 120),
    availability_notes: text(raw.availability_notes, 240),
    deliverables: text(raw.deliverables, LONG_MAX),
    questions: questions.slice(0, QUESTIONS_MAX),
  };
}
