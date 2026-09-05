import "server-only";
import { cookies, headers } from "next/headers";
import {
  LOCALE_COOKIE,
  localeFromAcceptLanguage,
  parseLocale,
  translate,
  type Locale,
  type Translate,
} from "@/lib/i18n";

/**
 * The locale a server component or generateMetadata should render in: the
 * saved cookie first, then the browser's Accept-Language. Same rule the root
 * layout uses to pick the initial locale for the client.
 */
export async function getRequestLocale(): Promise<Locale> {
  const requestCookies = await cookies();
  const requestHeaders = await headers();
  return (
    parseLocale(requestCookies.get(LOCALE_COOKIE)?.value) ??
    localeFromAcceptLanguage(requestHeaders.get("accept-language"))
  );
}

export async function getTranslator(): Promise<{ locale: Locale; t: Translate }> {
  const locale = await getRequestLocale();
  const t: Translate = (key, variables) => translate(locale, key, variables);
  return { locale, t };
}
