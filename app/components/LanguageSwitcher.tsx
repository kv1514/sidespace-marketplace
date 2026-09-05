"use client";

import { chooseLocale, useLocale, useT } from "@/lib/i18n/client";
import { LOCALES, LOCALE_NAMES, isLocale } from "@/lib/i18n/locales";

/**
 * Picks the language the site speaks. Choosing one reloads the page, so the
 * words the server rendered and the words the browser rendered can never
 * disagree with each other.
 */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const locale = useLocale();
  const t = useT();
  return (
    <label className={`ss-language${className ? ` ${className}` : ""}`}>
      <span className="sr-only">{t("Language")}</span>
      <select
        value={locale}
        onChange={(event) => {
          if (isLocale(event.target.value)) chooseLocale(event.target.value);
        }}
      >
        {LOCALES.map((code) => (
          <option key={code} value={code} lang={code}>
            {LOCALE_NAMES[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
