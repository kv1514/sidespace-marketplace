import { errorResponse, requireAuthenticatedProfile } from "@/lib/payments/auth";
import { readPromoBalance } from "@/lib/payments/balance-server";

export async function GET() {
  try {
    const { profile, admin } = await requireAuthenticatedProfile();
    const { eligible, balanceCents } = await readPromoBalance(admin, profile);
    return Response.json(
      { eligible, balanceCents },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export const runtime = "nodejs";
