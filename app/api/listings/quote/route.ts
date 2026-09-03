import { ApiError, errorResponse, requireUuid } from "@/lib/payments/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { validCalendarDay } from "@/lib/listings/availability";
import { MINIMUM_STRIPE_CHARGE_CENTS } from "@/lib/payments/ad-credits";
import { calculatePaymentBreakdown } from "@/lib/payments/fees";

/** A quote never creates a campaign, reserves a date, or contacts the owner. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const listingId = requireUuid(body?.listingId, "Choose a listing.");
    if (!validCalendarDay(body?.startDate) || !validCalendarDay(body?.endDate) ||
      typeof body?.listingUpdatedAt !== "string" || !Number.isFinite(Date.parse(body.listingUpdatedAt))) {
      throw new ApiError("Choose your dates and review the listing again.", 400);
    }
    const { data, error } = await createAdminClient().rpc("quote_listing_booking", {
      target_listing_id: listingId, booking_date: body.startDate,
      booking_end_date: body.endDate, expected_updated_at: body.listingUpdatedAt,
    });
    if (error) throw new ApiError(error.message, 409);
    if (!data || !Number.isSafeInteger(data.subtotalCents)) throw new ApiError("We couldn’t calculate this booking. Try again.", 503);
    const money = calculatePaymentBreakdown(data.subtotalCents);
    if (money.customerTotalCents < MINIMUM_STRIPE_CHARGE_CENTS) throw new ApiError("This booking is below the $0.50 payment minimum. Choose more days or make a custom offer.", 400);
    return Response.json({ ...data, ...money }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
