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
  type Locale,
  LOCALE_COOKIE,
  LOCALES,
  formatCurrency,
  formatDate,
  formatNumber,
  localeTag,
  translate,
  translateText,
  type TranslationKey,
} from "@/lib/i18n";
import {
  CURRENCIES,
  CURRENCY_COOKIE,
  convertUsdCents,
  DEFAULT_CURRENCY,
  formatMinorCurrency,
  type Currency,
} from "@/lib/currency";

type CurrencyRateStatus = "base" | "loading" | "ready" | "unavailable";
type CurrencyRateState = {
  currency: Currency;
  rate: number | null;
  status: CurrencyRateStatus;
};

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  currency: Currency;
  setCurrency: (currency: Currency) => void;
  currencyRate: number | null;
  currencyRateStatus: CurrencyRateStatus;
  t: (
    key: TranslationKey,
    variables?: Record<string, string | number>,
  ) => string;
  /**
   * For copy that reaches the screen as data rather than as a literal at the
   * call site: a toast, a validation message, a module-level label, a
   * sentence the server sent back. Looks the English up by value and
   * translates it; unknown text is shown as it is.
   */
  tx: (text: string, variables?: Record<string, string | number>) => string;
  formatNumber: (
    value: number,
    options?: Intl.NumberFormatOptions,
  ) => string;
  formatCurrency: (cents: number, currency?: string) => string;
  formatListingPrice: (usdCents: number) => string;
  formatDate: (
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function cookieSecurity() {
  return typeof location !== "undefined" && location.protocol === "https:"
    ? "; Secure"
    : "";
}

function persistLocale(locale: Locale) {
  if (typeof document === "undefined") return;
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax${cookieSecurity()}`;
  document.documentElement.lang = localeTag(locale);
  document.documentElement.dir = "ltr";
  document.documentElement.dataset.locale = locale;
}

function persistCurrency(currency: Currency) {
  if (typeof document === "undefined") return;
  document.cookie = `${CURRENCY_COOKIE}=${encodeURIComponent(currency)}; Path=/; Max-Age=31536000; SameSite=Lax${cookieSecurity()}`;
  document.documentElement.dataset.currency = currency;
}

export default function LocaleProvider({
  initialLocale = DEFAULT_LOCALE,
  initialCurrency = DEFAULT_CURRENCY,
  children,
}: {
  initialLocale?: Locale;
  initialCurrency?: Currency;
  children: ReactNode;
}) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [currency, setCurrency] = useState<Currency>(initialCurrency);
  const [currencyRateState, setCurrencyRateState] =
    useState<CurrencyRateState>({
      currency: initialCurrency,
      rate: initialCurrency === DEFAULT_CURRENCY ? 1 : null,
      status: initialCurrency === DEFAULT_CURRENCY ? "base" : "loading",
    });
  useEffect(() => {
    // The server resolves the request cookie/header before hydration. From
    // here on, the select is authoritative and this effect only synchronizes
    // the chosen locale to browser storage and document metadata.
    persistLocale(locale);
  }, [locale]);

  useEffect(() => {
    persistCurrency(currency);
    const controller = new AbortController();
    if (currency === DEFAULT_CURRENCY) {
      return () => controller.abort();
    }

    const targetCurrency = currency;
    void fetch(`/api/currency/rates?to=${encodeURIComponent(currency)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Currency rate unavailable.");
        return (await response.json()) as {
          currency?: unknown;
          rate?: unknown;
        };
      })
      .then((payload) => {
        if (payload.currency !== targetCurrency) {
          throw new Error("Currency response mismatch.");
        }
        const rate = Number(payload.rate);
        if (!Number.isFinite(rate) || rate <= 0) {
          throw new Error("Currency response was invalid.");
        }
        if (controller.signal.aborted) return;
        setCurrencyRateState({
          currency: targetCurrency,
          rate,
          status: "ready",
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setCurrencyRateState({
          currency: targetCurrency,
          rate: null,
          status: "unavailable",
        });
      });

    return () => controller.abort();
  }, [currency]);

  const currencyRate =
    currency === DEFAULT_CURRENCY
      ? 1
      : currencyRateState.currency === currency
        ? currencyRateState.rate
        : null;
  const currencyRateStatus: CurrencyRateStatus =
    currency === DEFAULT_CURRENCY
      ? "base"
      : currencyRateState.currency === currency
        ? currencyRateState.status
        : "loading";

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      currency,
      setCurrency,
      currencyRate,
      currencyRateStatus,
      t: (key, variables) => translate(locale, key, variables),
      tx: (text, variables) => translateText(locale, text, variables),
      formatNumber: (valueToFormat, options) =>
        formatNumber(locale, valueToFormat, options),
      formatCurrency: (cents, currency) =>
        formatCurrency(locale, cents, currency),
      formatListingPrice: (usdCents) => {
        if (
          currency !== DEFAULT_CURRENCY &&
          currencyRateStatus === "ready" &&
          currencyRate
        ) {
          try {
            return formatMinorCurrency(
              locale,
              convertUsdCents(usdCents, currency, currencyRate),
              currency,
            );
          } catch {
            // A malformed listing should never take the marketplace down. It
            // falls back to the authoritative USD display for this one value.
          }
        }
        return formatCurrency(locale, usdCents, DEFAULT_CURRENCY);
      },
      formatDate: (valueToFormat, options) =>
        formatDate(locale, valueToFormat, options),
    }),
    [currency, currencyRate, currencyRateStatus, locale],
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
    currency,
    currencyRate,
    currencyRateStatus,
    locale,
    setLocale,
    setCurrency,
    formatNumber,
    t,
    tx,
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
              <div className="ss-currency-options">
                {CURRENCIES.map((option) => (
                  <button
                    type="button"
                    key={option.code}
                    className={option.code === currency ? "is-selected" : ""}
                    aria-pressed={option.code === currency}
                    onClick={() => setCurrency(option.code)}
                  >
                    <span>
                      <strong>{option.symbol} {option.code}</strong>
                      <small>{tx(option.name)}</small>
                    </span>
                    {option.code === currency && <b aria-hidden="true">✓</b>}
                  </button>
                ))}
              </div>
              <p className="ss-currency-status" role="status" aria-live="polite">
                {currency === DEFAULT_CURRENCY
                  ? t("chrome.pricesShownInUsd")
                  : currencyRateStatus === "loading"
                    ? t("chrome.currencyRateLoading")
                    : currencyRateStatus === "ready" && currencyRate
                      ? t("chrome.currencyRate", {
                          rate: formatNumber(currencyRate, {
                            maximumFractionDigits: 6,
                          }),
                          currency,
                        })
                      : t("chrome.currencyRateUnavailable")}
              </p>
              <p className="ss-currency-checkout-note">
                {t("chrome.currencyCheckoutNote")}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
