import "server-only";

import {
  DEFAULT_CURRENCY,
  parseCurrency,
  type Currency,
} from "@/lib/currency";

type FrankfurterRateResponse = {
  date?: unknown;
  base?: unknown;
  quote?: unknown;
  rate?: unknown;
};

type CachedRate = {
  rate: number;
  referenceRateProvider: string;
  rateDate: string | null;
  fetchedAt: string;
  expiresAt: number;
};

// Frankfurter publishes central-bank reference rates daily. Keeping the
// server cache warm for a few hours avoids needless public-API traffic while
// still picking up the next working day's ECB rate promptly.
const RATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const rateCache = new Map<Currency, CachedRate>();

function responseHeaders() {
  return {
    "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=86400",
  };
}

function numberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function fetchEcbReferenceRate(currency: Currency): Promise<CachedRate> {
  const endpoint = new URL(
    `https://api.frankfurter.dev/v2/rate/${DEFAULT_CURRENCY}/${currency}`,
  );
  // Pin the source to the ECB instead of using Frankfurter's blended default.
  endpoint.searchParams.set("providers", "ECB");

  const response = await fetch(endpoint, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`ECB reference rate returned ${response.status}`);

  const payload = (await response.json().catch(() => null)) as
    | FrankfurterRateResponse
    | null;
  if (
    payload?.base !== DEFAULT_CURRENCY ||
    payload?.quote !== currency
  ) {
    throw new Error("ECB reference rate returned the wrong currency pair.");
  }
  const rate = numberOrNull(payload?.rate);
  if (!rate) throw new Error("ECB reference rate did not include a usable rate.");

  const fetchedAt = new Date().toISOString();
  return {
    rate,
    referenceRateProvider: "ECB",
    rateDate:
      typeof payload?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.date)
        ? payload.date
        : null,
    fetchedAt,
    expiresAt: Date.now() + RATE_CACHE_TTL_MS,
  };
}

export async function GET(request: Request) {
  const currency = parseCurrency(new URL(request.url).searchParams.get("to"));
  if (!currency) {
    return Response.json(
      { error: "Choose a supported currency." },
      { status: 400 },
    );
  }

  if (currency === DEFAULT_CURRENCY) {
    return Response.json(
      {
        baseCurrency: DEFAULT_CURRENCY,
        currency,
        rate: 1,
        referenceRate: 1,
        referenceRateProvider: "identity",
        rateDate: null,
        fetchedAt: new Date().toISOString(),
      },
      { headers: responseHeaders() },
    );
  }

  const cached = rateCache.get(currency);
  if (cached && cached.expiresAt > Date.now()) {
    return Response.json(
      {
        baseCurrency: DEFAULT_CURRENCY,
        currency,
        rate: cached.rate,
        referenceRate: cached.rate,
        referenceRateProvider: cached.referenceRateProvider,
        rateDate: cached.rateDate,
        fetchedAt: cached.fetchedAt,
      },
      { headers: responseHeaders() },
    );
  }

  try {
    const fresh = await fetchEcbReferenceRate(currency);
    rateCache.set(currency, fresh);
    return Response.json(
      {
        baseCurrency: DEFAULT_CURRENCY,
        currency,
        rate: fresh.rate,
        referenceRate: fresh.rate,
        referenceRateProvider: fresh.referenceRateProvider,
        rateDate: fresh.rateDate,
        fetchedAt: fresh.fetchedAt,
      },
      { headers: responseHeaders() },
    );
  } catch (error) {
    console.error(
      "[currency rates] ECB reference rate failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return Response.json(
      { error: "Live currency conversion is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
