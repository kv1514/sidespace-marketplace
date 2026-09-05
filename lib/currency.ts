import { localeTag, type Locale } from "@/lib/i18n";

export const CURRENCIES = [
  { code: "USD", name: "US dollar", symbol: "$", minorUnit: 2 },
  { code: "CNY", name: "Chinese yuan", symbol: "¥", minorUnit: 2 },
  { code: "SGD", name: "Singapore dollar", symbol: "S$", minorUnit: 2 },
  { code: "EUR", name: "Euro", symbol: "€", minorUnit: 2 },
  { code: "GBP", name: "British pound", symbol: "£", minorUnit: 2 },
  { code: "JPY", name: "Japanese yen", symbol: "¥", minorUnit: 0 },
  { code: "KRW", name: "South Korean won", symbol: "₩", minorUnit: 0 },
  { code: "INR", name: "Indian rupee", symbol: "₹", minorUnit: 2 },
  { code: "CAD", name: "Canadian dollar", symbol: "CA$", minorUnit: 2 },
  { code: "AUD", name: "Australian dollar", symbol: "A$", minorUnit: 2 },
  { code: "NZD", name: "New Zealand dollar", symbol: "NZ$", minorUnit: 2 },
  { code: "HKD", name: "Hong Kong dollar", symbol: "HK$", minorUnit: 2 },
  { code: "TWD", name: "New Taiwan dollar", symbol: "NT$", minorUnit: 2 },
  { code: "THB", name: "Thai baht", symbol: "฿", minorUnit: 2 },
  { code: "CHF", name: "Swiss franc", symbol: "CHF", minorUnit: 2 },
  { code: "MXN", name: "Mexican peso", symbol: "MX$", minorUnit: 2 },
  { code: "BRL", name: "Brazilian real", symbol: "R$", minorUnit: 2 },
  { code: "ZAR", name: "South African rand", symbol: "R", minorUnit: 2 },
  { code: "SEK", name: "Swedish krona", symbol: "kr", minorUnit: 2 },
  { code: "NOK", name: "Norwegian krone", symbol: "kr", minorUnit: 2 },
  { code: "DKK", name: "Danish krone", symbol: "kr", minorUnit: 2 },
  { code: "PLN", name: "Polish zloty", symbol: "zł", minorUnit: 2 },
  { code: "CZK", name: "Czech koruna", symbol: "Kč", minorUnit: 2 },
] as const;

export type Currency = (typeof CURRENCIES)[number]["code"];

export const DEFAULT_CURRENCY: Currency = "USD";
export const CURRENCY_COOKIE = "sidespace_currency";

const CURRENCY_CODES = new Set<string>(CURRENCIES.map((currency) => currency.code));

const EURO_COUNTRIES = new Set([
  "AT",
  "BE",
  "CY",
  "DE",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PT",
  "SI",
  "SK",
]);

const COUNTRY_CURRENCIES: Readonly<Record<string, Currency>> = {
  AU: "AUD",
  BR: "BRL",
  CA: "CAD",
  CH: "CHF",
  CN: "CNY",
  CZ: "CZK",
  DK: "DKK",
  GB: "GBP",
  HK: "HKD",
  IN: "INR",
  JP: "JPY",
  KR: "KRW",
  MX: "MXN",
  NO: "NOK",
  NZ: "NZD",
  PL: "PLN",
  SE: "SEK",
  SG: "SGD",
  TH: "THB",
  TW: "TWD",
  US: "USD",
  ZA: "ZAR",
};

function currencyOption(currency: Currency) {
  return CURRENCIES.find((option) => option.code === currency) ?? CURRENCIES[0];
}

function normalizeRegion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function regionFromLocaleTag(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value.replaceAll("_", "-").split("-");
  return (
    parts
      .slice(1)
      .map((part) => part.toUpperCase())
      .find((part) => /^[A-Z]{2}$/.test(part)) ?? null
  );
}

export function parseCurrency(value: unknown): Currency | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return CURRENCY_CODES.has(normalized) ? (normalized as Currency) : null;
}

export function currencyFromCountry(country: unknown): Currency | null {
  const region = normalizeRegion(country);
  if (!region) return null;
  return COUNTRY_CURRENCIES[region] ?? (EURO_COUNTRIES.has(region) ? "EUR" : null);
}

/** Return the first supported region in a browser Accept-Language header. */
export function regionFromAcceptLanguage(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const candidates = value
    .split(",")
    .map((part, index) => {
      const [rawTag, ...parameters] = part.trim().split(";");
      const qualityParameter = parameters.find((parameter) =>
        parameter.trim().startsWith("q="),
      );
      const quality = qualityParameter
        ? Number(qualityParameter.trim().slice(2))
        : 1;
      return {
        tag: rawTag,
        quality: Number.isFinite(quality) ? quality : 0,
        index,
      };
    })
    .filter((candidate) => candidate.quality > 0)
    .sort(
      (left, right) =>
        right.quality - left.quality || left.index - right.index,
    );

  for (const candidate of candidates) {
    const region = regionFromLocaleTag(candidate.tag);
    if (region) return region;
  }
  return null;
}

export function currencyFromLocale(locale: Locale): Currency {
  const region = regionFromLocaleTag(localeTag(locale));
  return currencyFromCountry(region) ?? (locale === "zh" ? "CNY" : DEFAULT_CURRENCY);
}

export function currencyFromRequest({
  cookie,
  country,
  acceptLanguage,
  locale,
}: {
  cookie?: unknown;
  country?: unknown;
  acceptLanguage?: string | null;
  locale?: Locale | null;
}): Currency {
  return (
    parseCurrency(cookie) ??
    currencyFromCountry(country) ??
    currencyFromCountry(regionFromAcceptLanguage(acceptLanguage)) ??
    (locale ? currencyFromLocale(locale) : DEFAULT_CURRENCY)
  );
}

export function minorUnitFor(currency: Currency): number {
  return currencyOption(currency).minorUnit;
}

/** Convert USD cents to the target currency's smallest unit. */
export function convertUsdCents(
  usdCents: number,
  currency: Currency,
  usdToCurrencyRate: number,
): number {
  if (!Number.isSafeInteger(usdCents) || usdCents < 0) {
    throw new Error("USD cents must be a non-negative safe integer.");
  }
  if (!Number.isFinite(usdToCurrencyRate) || usdToCurrencyRate <= 0) {
    throw new Error("The exchange rate must be a positive finite number.");
  }
  const targetMinor = Math.round(
    (usdCents / 100) * usdToCurrencyRate * 10 ** minorUnitFor(currency),
  );
  if (!Number.isSafeInteger(targetMinor)) {
    throw new Error("The converted amount is outside the safe integer range.");
  }
  return targetMinor;
}

export function formatMinorCurrency(
  locale: Locale,
  amountMinor: number,
  currency: Currency,
): string {
  const minorUnit = minorUnitFor(currency);
  return new Intl.NumberFormat(localeTag(locale), {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
    minimumFractionDigits: minorUnit,
    maximumFractionDigits: minorUnit,
  }).format(amountMinor / 10 ** minorUnit);
}
