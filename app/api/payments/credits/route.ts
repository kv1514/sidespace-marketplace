import { errorResponse, requireAuthenticatedProfile } from "@/lib/payments/auth";

function safeLedgerCents(value: unknown) {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents)) {
    throw new Error("The advertising credit ledger returned an invalid amount.");
  }
  return cents;
}

export async function GET() {
  try {
    const { profile, admin } = await requireAuthenticatedProfile();
    if (profile.role !== "business") {
      return Response.json(
        { eligible: false, balanceCents: 0 },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    const { data, error } = await admin
      .from("business_ad_credit_ledger")
      .select("amount_cents")
      .eq("business_profile_id", profile.id);
    if (error) throw error;

    const balanceCents = (data ?? []).reduce(
      (balance, entry) => balance + safeLedgerCents(entry.amount_cents),
      0,
    );
    if (!Number.isSafeInteger(balanceCents) || balanceCents < 0) {
      throw new Error("The advertising credit ledger balance is invalid.");
    }

    return Response.json(
      { eligible: true, balanceCents },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export const runtime = "nodejs";
