export const BASIS_POINTS_PER_WHOLE = 10_000;
export const BUYER_FEE_BASIS_POINTS = 500;
export const CREATOR_FEE_BASIS_POINTS = 500;

export type PaymentBreakdown = {
  subtotalCents: number;
  buyerFeeCents: number;
  creatorFeeCents: number;
  customerTotalCents: number;
  creatorPayoutCents: number;
  platformGrossRevenueCents: number;
};

function assertCents(value: number, label = "Amount") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer in cents.`);
  }
}

export function percentageFeeCents(amountCents: number, basisPoints: number) {
  assertCents(amountCents);
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError("Basis points must be a non-negative safe integer.");
  }
  return Math.round((amountCents * basisPoints) / BASIS_POINTS_PER_WHOLE);
}

export function calculatePaymentBreakdown(subtotalCents: number): PaymentBreakdown {
  assertCents(subtotalCents, "Subtotal");
  if (subtotalCents === 0) {
    throw new RangeError("Subtotal must be greater than zero.");
  }

  const buyerFeeCents = percentageFeeCents(
    subtotalCents,
    BUYER_FEE_BASIS_POINTS,
  );
  const creatorFeeCents = percentageFeeCents(
    subtotalCents,
    CREATOR_FEE_BASIS_POINTS,
  );

  return {
    subtotalCents,
    buyerFeeCents,
    creatorFeeCents,
    customerTotalCents: subtotalCents + buyerFeeCents,
    creatorPayoutCents: subtotalCents - creatorFeeCents,
    platformGrossRevenueCents: buyerFeeCents + creatorFeeCents,
  };
}

export function dollarsToCents(value: string | number) {
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new RangeError("Enter a dollar amount with no more than two decimals.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  assertCents(cents);
  return cents;
}

export function centsToInputDollars(cents: number) {
  assertCents(cents);
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

export function formatCents(cents: number, currency = "USD") {
  assertCents(cents);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}
