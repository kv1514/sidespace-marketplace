import "server-only";

import { cookies, headers } from "next/headers";
import { loadDictionary } from "./dictionaries";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "./locales";
import { createTranslator, type Translate } from "./translate";

/**
 * The language this request should be answered in: the cookie an explicit
 * choice set, else the browser's Accept-Language, else English. Reading the
 * request makes the route dynamic, which every page that matters already is.
 */
export async function getLocale(): Promise<Locale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get("accept-language"),
  );
}

export async function getTranslator(): Promise<Translate> {
  const locale = await getLocale();
  return createTranslator(locale, await loadDictionary(locale));
}
