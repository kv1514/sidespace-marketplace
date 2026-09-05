"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  type Locale,
} from "./locales";
import { createTranslator, type Dictionary, type Translate } from "./translate";

const LocaleContext = createContext<Translate>(
  createTranslator(DEFAULT_LOCALE, {}),
);

export function LocaleProvider({
  locale,
  dictionary,
  children,
}: {
  locale: Locale;
  dictionary: Dictionary;
  children: ReactNode;
}) {
  const translate = useMemo(
    () => createTranslator(locale, dictionary),
    [locale, dictionary],
  );
  return (
    <LocaleContext.Provider value={translate}>{children}</LocaleContext.Provider>
  );
}

/**
 * The translator for the language this page was served in. Its identity does
 * not change while the page is open: a new language is a new page load, so
 * every server- and client-rendered word changes together.
 */
export function useT(): Translate {
  return useContext(LocaleContext);
}

export function useLocale(): Locale {
  return useContext(LocaleContext).locale;
}

/** Remember a choice for a year and start over in it. */
export function chooseLocale(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
  window.location.reload();
}
