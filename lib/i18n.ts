import {
  ENGLISH_MESSAGES,
  type Messages,
  type TranslationKey,
} from "./i18n-messages/en";
import { SPANISH_MESSAGES } from "./i18n-messages/es";
import { FRENCH_MESSAGES } from "./i18n-messages/fr";
import { MANDARIN_MESSAGES } from "./i18n-messages/zh";
import { KOREAN_MESSAGES } from "./i18n-messages/ko";
import { VIETNAMESE_MESSAGES } from "./i18n-messages/vi";

export const LOCALE_COOKIE = "sidespace_locale";
export const DEFAULT_LOCALE = "en" as const;

export const LOCALES = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "es", label: "Spanish", nativeLabel: "Español" },
  { code: "fr", label: "French", nativeLabel: "Français" },
  { code: "zh", label: "Mandarin Chinese", nativeLabel: "简体中文" },
  { code: "ko", label: "Korean", nativeLabel: "한국어" },
  { code: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

export type { TranslationKey };

export const MESSAGES: Record<Locale, Messages> = {
  en: ENGLISH_MESSAGES,
  es: SPANISH_MESSAGES,
  fr: FRENCH_MESSAGES,
  zh: MANDARIN_MESSAGES,
  ko: KOREAN_MESSAGES,
  vi: VIETNAMESE_MESSAGES,
};

const LOCALE_TAGS: Record<Locale, string> = {
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  zh: "zh-CN",
  ko: "ko-KR",
  vi: "vi-VN",
};

export function parseLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  const exact = LOCALES.find((item) => item.code === normalized);
  if (exact) return exact.code;
  const base = normalized.split("-", 1)[0];
  return LOCALES.find((item) => item.code === base)?.code ?? null;
}

export function localeFromAcceptLanguage(value: string | null | undefined): Locale {
  if (!value) return DEFAULT_LOCALE;
  const candidates = value
    .split(",")
    .map((part, index) => {
      const [tag, ...parameters] = part.trim().split(";");
      const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
      const weight = quality ? Number(quality.trim().slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((candidate) => candidate.weight > 0)
    .sort((left, right) => right.weight - left.weight || left.index - right.index);

  for (const candidate of candidates) {
    const locale = parseLocale(candidate.tag);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

export function resolveLocale(value: unknown): Locale {
  return parseLocale(value) ?? DEFAULT_LOCALE;
}

function interpolate(
  template: string,
  variables: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name)
      ? String(variables[name])
      : match,
  );
}

export function translate(
  locale: Locale,
  key: TranslationKey,
  variables: Record<string, string | number> = {},
): string {
  const template = MESSAGES[locale][key] ?? MESSAGES[DEFAULT_LOCALE][key];
  return interpolate(template, variables);
}

/** The shape of t(), for helpers that run outside a component and are handed one. */
export type Translate = (
  key: TranslationKey,
  variables?: Record<string, string | number>,
) => string;

/** English, for call sites that have no locale to hand: server logs, tests, defaults. */
export const translateEnglish: Translate = (key, variables) =>
  translate(DEFAULT_LOCALE, key, variables);

let keyByEnglish: Map<string, TranslationKey> | null = null;

/**
 * The key whose English copy is exactly this text. Copy that reaches the
 * screen as data rather than as a literal at the call site - a toast, a
 * validation message, a module-level label, a sentence the server sent back -
 * is translated by looking its English up here.
 */
export function keyForText(text: string): TranslationKey | null {
  if (!keyByEnglish) {
    keyByEnglish = new Map();
    for (const [key, value] of Object.entries(ENGLISH_MESSAGES)) {
      if (!keyByEnglish.has(value)) keyByEnglish.set(value, key as TranslationKey);
    }
  }
  return keyByEnglish.get(text) ?? null;
}

export function translateText(
  locale: Locale,
  text: string,
  variables: Record<string, string | number> = {},
): string {
  const key = keyForText(text);
  return key ? translate(locale, key, variables) : interpolate(text, variables);
}

const LISTING_CHANNEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  Instagram: "home.itemInstagram",
  TikTok: "home.categoryTikTok",
  Newsletter: "home.categoryNewsletter",
  Storefront: "home.inventoryStorefront",
  Vehicle: "home.inventoryVehicle",
  "Community board": "home.categoryCommunityBoard",
  "Wall / mural": "home.categoryWall",
  Sponsorship: "home.categoryEventSponsorship",
  "Business brief": "market.wanted",
  "Cafe window": "market.channelCafeWindow",
  "Main Street": "market.channelMainStreet",
  "Farm stand": "market.channelFarmStand",
  "Counter card": "market.channelCounterCard",
  "Bakery window": "market.channelBakeryWindow",
  Website: "app.website",
  "Room / interior": "app.roomInterior",
  Other: "app.other",
};

const LISTING_UNIT_KEYS: Readonly<Record<string, TranslationKey>> = {
  week: "home.unitWeek",
  day: "home.unitDay",
  campaign: "home.unitCampaign",
  video: "home.unitVideo",
  "story set": "home.unitStorySet",
  partner: "home.unitPartner",
  run: "home.unitRun",
  mention: "home.unitMention",
  package: "home.unitPackage",
  delivery: "home.unitDelivery",
  "30 days": "home.unitThirtyDays",
  post: "home.unitPost",
  sponsor: "home.unitSponsor",
};

const ROLE_KEYS: Readonly<Record<string, TranslationKey>> = {
  business: "role.business",
  creator: "role.creator",
  space_owner: "role.spaceOwner",
  sponsor_host: "role.sponsorHost",
  consumer: "role.consumer",
};

export function localizeListingChannel(locale: Locale, value: string): string {
  const key = LISTING_CHANNEL_KEYS[value];
  return key ? translate(locale, key) : value;
}

export function localizeListingUnit(locale: Locale, value: string): string {
  const key = LISTING_UNIT_KEYS[value.trim().toLowerCase()];
  return key ? translate(locale, key) : value;
}

export function localizeRole(locale: Locale, value: string): string {
  const key = ROLE_KEYS[value.trim().toLowerCase()];
  return key ? translate(locale, key) : value;
}

export function localeTag(locale: Locale): string {
  return LOCALE_TAGS[locale];
}

export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(localeTag(locale), options).format(value);
}

export function formatCurrency(
  locale: Locale,
  cents: number,
  currency = "USD",
): string {
  return new Intl.NumberFormat(localeTag(locale), {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatDate(
  locale: Locale,
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(localeTag(locale), options).format(new Date(value));
}
