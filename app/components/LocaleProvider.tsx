"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LISTING_TRANSLATION_COOKIE,
  LOCALES,
  formatCurrency,
  formatDate,
  formatNumber,
  localeTag,
  translate,
  type Locale,
  type TranslationKey,
} from "@/lib/i18n";

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  translateListings: boolean;
  setTranslateListings: (enabled: boolean) => void;
  t: (
    key: TranslationKey,
    variables?: Record<string, string | number>,
  ) => string;
  formatNumber: (
    value: number,
    options?: Intl.NumberFormatOptions,
  ) => string;
  formatCurrency: (cents: number, currency?: string) => string;
  formatDate: (
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function persistLocale(locale: Locale) {
  if (typeof document === "undefined") return;
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  document.documentElement.lang = localeTag(locale);
  document.documentElement.dir = "ltr";
  document.documentElement.dataset.locale = locale;
}

function persistListingTranslationPreference(enabled: boolean) {
  if (typeof document === "undefined") return;
  document.cookie = `${LISTING_TRANSLATION_COOKIE}=${enabled ? "1" : "0"}; Path=/; Max-Age=31536000; SameSite=Lax`;
  document.documentElement.dataset.translateListings = enabled ? "true" : "false";
}

export default function LocaleProvider({
  initialLocale = DEFAULT_LOCALE,
  initialTranslateListings = true,
  children,
}: {
  initialLocale?: Locale;
  initialTranslateListings?: boolean;
  children: ReactNode;
}) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [translateListings, setTranslateListings] = useState(
    initialTranslateListings,
  );

  useEffect(() => {
    // The server resolves the request cookie/header before hydration. From
    // here on, the select is authoritative and this effect only synchronizes
    // the chosen locale to browser storage and document metadata.
    persistLocale(locale);
  }, [locale]);

  useEffect(() => {
    persistListingTranslationPreference(translateListings);
  }, [translateListings]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      translateListings,
      setTranslateListings,
      t: (key, variables) => translate(locale, key, variables),
      formatNumber: (valueToFormat, options) =>
        formatNumber(locale, valueToFormat, options),
      formatCurrency: (cents, currency) =>
        formatCurrency(locale, cents, currency),
      formatDate: (valueToFormat, options) =>
        formatDate(locale, valueToFormat, options),
    }),
    [locale, translateListings],
  );

  return (
    <LocaleContext.Provider value={value}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useLocale must be used inside LocaleProvider");
  }
  return context;
}

export function LanguageSwitcher() {
  const {
    locale,
    setLocale,
    translateListings,
    setTranslateListings,
    t,
  } = useLocale();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"language" | "currency">("language");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const selectedLocale = LOCALES.find((option) => option.code === locale) ?? LOCALES[0];

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        panelRef.current &&
        event.target instanceof Node &&
        !panelRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div className="ss-language-switcher" ref={panelRef}>
      <button
        type="button"
        className="ss-language-switcher-toggle"
        aria-label={t("chrome.languageAndRegion")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">◎</span>
        <b>{selectedLocale.nativeLabel}</b>
        <i aria-hidden="true">⌄</i>
      </button>
      {open && (
        <div
          className="ss-language-panel"
          role="dialog"
          aria-label={t("chrome.languageAndRegion")}
        >
          <header className="ss-language-panel-header">
            <strong>{t("chrome.languageAndRegion")}</strong>
            <button
              type="button"
              className="ss-language-panel-close"
              aria-label={t("chrome.closeLanguageSettings")}
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>
          <div className="ss-language-panel-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={panel === "language"}
              className={panel === "language" ? "is-active" : ""}
              onClick={() => setPanel("language")}
            >
              {t("chrome.languageAndRegion")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panel === "currency"}
              className={panel === "currency" ? "is-active" : ""}
              onClick={() => setPanel("currency")}
            >
              {t("chrome.currency")}
            </button>
          </div>
          {panel === "language" ? (
            <div role="tabpanel" className="ss-language-panel-body">
              <label className="ss-translation-toggle">
                <span>
                  <strong>{t("chrome.translation")}</strong>
                  <small>{t("chrome.autoTranslateListingsDescription")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={translateListings}
                  onChange={(event) =>
                    setTranslateListings(event.currentTarget.checked)
                  }
                  aria-label={t("chrome.autoTranslateListings")}
                />
              </label>
              <h2>{t("chrome.chooseLanguageRegion")}</h2>
              <div className="ss-language-options">
                {LOCALES.map((option) => (
                  <button
                    type="button"
                    key={option.code}
                    className={option.code === locale ? "is-selected" : ""}
                    onClick={() => {
                      setLocale(option.code);
                      setOpen(false);
                    }}
                  >
                    <strong>{option.nativeLabel}</strong>
                    <small>{option.label}</small>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div role="tabpanel" className="ss-language-panel-body ss-currency-panel">
              <h2>{t("chrome.currencyTitle")}</h2>
              <p>{t("chrome.currencyDescription")}</p>
              <div className="ss-currency-option">
                <strong>{t("chrome.currencyUsdOnly")}</strong>
                <span>✓</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
