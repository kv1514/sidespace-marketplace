/**
 * The languages the interface speaks.
 *
 * Only the site's own words are translated: navigation, buttons, forms,
 * toasts, page copy. A listing stays in whatever language its owner wrote it
 * in, and the emails the database queues are still English. The URL never
 * changes with the language - the choice lives in a cookie, and a first-time
 * visitor gets whatever their browser asks for.
 */

export const LOCALES = ["en", "es", "zh", "ko", "vi"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Set only by an explicit choice. Absent means "follow the browser". */
export const LOCALE_COOKIE = "sidespace_locale";

export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** How each language names itself, which is how a switcher should list it. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Español",
  zh: "中文",
  ko: "한국어",
  vi: "Tiếng Việt",
};

/** BCP 47 tags for `<html lang>` and for `Intl`. */
export const LOCALE_TAGS: Record<Locale, string> = {
  en: "en-US",
  es: "es",
  zh: "zh-Hans",
  ko: "ko",
  vi: "vi",
};

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}

/**
 * The closest language we have for a browser tag, or null.
 *
 * Region and script are dropped: `es-419` is Spanish, and `zh-TW` gets the
 * Simplified Chinese we have rather than English, which reads worse to a
 * Traditional reader than the wrong script does.
 */
export function localeFromTag(tag: string): Locale | null {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(primary) ? primary : null;
}

/**
 * The best supported language in an Accept-Language header, or null when the
 * browser asks for nothing we have. Quality values are honoured, so
 * `fr, es;q=0.8` is Spanish and `en-US, es;q=0.9` is English.
 */
export function localeFromAcceptLanguage(
  header: string | null | undefined,
): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const quality = params
        .map((param) => param.trim())
        .find((param) => param.startsWith("q="));
      const weight = quality ? Number(quality.slice(2)) : 1;
      return {
        tag: tag.trim(),
        weight: Number.isFinite(weight) ? weight : 0,
        index,
      };
    })
    .filter((entry) => entry.tag && entry.tag !== "*" && entry.weight > 0)
    .sort((left, right) => right.weight - left.weight || left.index - right.index);
  for (const entry of ranked) {
    const locale = localeFromTag(entry.tag);
    if (locale) return locale;
  }
  return null;
}

/** An explicit choice wins; otherwise the browser's preference; otherwise English. */
export function resolveLocale(
  cookieValue: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  return localeFromAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}
