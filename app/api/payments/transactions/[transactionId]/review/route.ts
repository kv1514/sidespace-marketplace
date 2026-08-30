import {
  ApiError,
  errorResponse,
  requireAuthenticatedProfile,
  requireSameOrigin,
  requireUuid,
} from "@/lib/payments/auth";

export async function POST(
  request: Request,
  context: { params: Promise<{ transactionId: string }> },
) {
  try {
    requireSameOrigin(request);
    const { transactionId: rawTransactionId } = await context.params;
    const transactionId = requireUuid(rawTransactionId, "Payment transaction not found.");
    const body = (await request.json().catch(() => null)) as {
      rating?: unknown;
      review?: unknown;
    } | null;
    const rating = Number(body?.rating);
    const review = String(body?.review ?? "").trim();
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new ApiError("Choose a rating from 1 to 5.", 400);
    }
    if (review.length < 10 || review.length > 2000) {
      throw new ApiError("Write a review between 10 and 2,000 characters.", 400);
    }
    const { profile, admin } = await requireAuthenticatedProfile();
    const result = await admin.rpc("create_creator_review", {
      target_transaction_id: transactionId,
      actor_profile_id: profile.id,
      review_rating: rating,
      review_body: review,
    });
    if (result.error) {
      const forbidden = /only the payer/i.test(result.error.message);
      throw new ApiError(result.error.message, forbidden ? 403 : 409);
    }
    return Response.json({ review: result.data });
  } catch (error) {
    return errorResponse(error);
  }
}

export const runtime = "nodejs";

