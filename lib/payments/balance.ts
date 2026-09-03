export type CurrencyBalance = { currency: string; availableCents: number; pendingCents: number };
export type EarningsBalance = { currency: string; earnedCents: number; pendingCents: number };
export type PromoBalance = {
  eligible: boolean;
  balanceCents: number;
  activity: { id: string; amountCents: number; type: string; createdAt: string }[];
};
export type AccountBalance = {
  livemode: boolean | null;
  stripe: {
    status: "connected" | "not_connected" | "unavailable" | "not_eligible";
    payoutsEnabled: boolean;
    balances: CurrencyBalance[];
  };
  earnings: EarningsBalance[] | null;
  promo: PromoBalance | null;
};

export function ledgerCents(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error("Missing balance amount.");
  }
  if (typeof value === "string" && !/^-?\d+$/.test(value)) {
    throw new Error("Invalid balance amount.");
  }
  const cents = Number(value);
  if (!Number.isSafeInteger(cents)) throw new Error("Invalid balance amount.");
  return cents;
}

export type EarningsRow = {
  currency: string;
  paid_at: string | null;
  status: string;
  payout_status: string;
  payout_amount_cents: number;
  payout_recovery_target_cents: number;
  payout_recovery_reversed_cents: number;
};

/** Released earnings are lifetime net transfers, not the current bank balance. */
export function summarizeEarnings(rows: EarningsRow[]): EarningsBalance[] {
  const currencies = new Map<string, EarningsBalance>();
  for (const row of rows) {
    if (!row.paid_at) continue;
    const currency = row.currency.toLowerCase();
    const total = currencies.get(currency) ?? { currency, earnedCents: 0, pendingCents: 0 };
    const payout = ledgerCents(row.payout_amount_cents);
    const recovery = Math.max(ledgerCents(row.payout_recovery_target_cents), ledgerCents(row.payout_recovery_reversed_cents));
    if (payout < 0 || recovery < 0 || recovery > payout) throw new Error("Invalid payout balance.");
    if (row.payout_status === "released") {
      total.earnedCents = ledgerCents(total.earnedCents + payout - recovery);
    } else if (["paid", "partially_refunded", "disputed"].includes(row.status)) {
      total.pendingCents = ledgerCents(total.pendingCents + payout - recovery);
    }
    currencies.set(currency, total);
  }
  return [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export function summarizeStripeBalance(balance: {
  available: { currency: string; amount: number }[];
  pending: { currency: string; amount: number }[];
}): CurrencyBalance[] {
  const currencies = new Map<string, CurrencyBalance>();
  for (const [key, amounts] of [["availableCents", balance.available], ["pendingCents", balance.pending]] as const) {
    for (const amount of amounts) {
      const currency = amount.currency.toLowerCase();
      const total = currencies.get(currency) ?? { currency, availableCents: 0, pendingCents: 0 };
      total[key] = ledgerCents(total[key] + ledgerCents(amount.amount));
      currencies.set(currency, total);
    }
  }
  return [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
