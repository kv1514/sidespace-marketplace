import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ledgerCents, type PromoBalance } from "./balance";

/** Read every page: PostgREST's row cap must never truncate a money balance. */
export async function readBalancePages<T>(read: (from: number, to: number) => PromiseLike<{
  data: T[] | null; error: unknown; count: number | null;
}>) {
  const rows: T[] = [];
  let count: number;
  do {
    const result = await read(rows.length, rows.length + 499);
    if (result.error) throw result.error;
    if (result.count === null) throw new Error("Balance count is unavailable.");
    count = result.count;
    if (!result.data?.length && rows.length < count) throw new Error("Incomplete balance data.");
    rows.push(...(result.data ?? []));
  } while (rows.length < count);
  return rows;
}

export async function readPromoBalance(admin: SupabaseClient, profile: { id: string; role: string }): Promise<PromoBalance> {
  if (profile.role !== "business") return { eligible: false, balanceCents: 0, activity: [] };
  // One database snapshot avoids pagination races while new grants/checkouts
  // append ledger entries, and aggregates beyond PostgREST's response row cap.
  const { data, error } = await admin.rpc("get_business_ad_credit_balance", { target_profile_id: profile.id });
  if (error) throw error;
  const balanceCents = ledgerCents(data?.balance_cents);
  if (balanceCents < 0) throw new Error("Invalid promotional credit balance.");
  return {
    eligible: true, balanceCents,
    activity: (data.activity ?? []).map((row: { id: string; amount_cents: number; entry_type: string; created_at: string }) => ({
      id: row.id, amountCents: ledgerCents(row.amount_cents), type: row.entry_type, createdAt: row.created_at,
    })),
  };
}
