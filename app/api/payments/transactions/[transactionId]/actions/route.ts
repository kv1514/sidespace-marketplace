import {
  ApiError,
  errorResponse,
  requireAuthenticatedProfile,
  requireSameOrigin,
  requireUuid,
} from "@/lib/payments/auth";
import { releasePendingPayout } from "@/lib/payments/release";
import { enforcePaymentRateLimit } from "@/lib/payments/rate-limit";
import { participantTransactionResponse } from "@/lib/payments/response";

type PaymentAction = "deliver" | "confirm" | "report_issue" | "escalate";

function actionError(error: { message?: string } | null) {
  const message = error?.message || "That campaign action could not be completed.";
  const forbidden = /only the|authorization|required staff/i.test(message);
  throw new ApiError(message, forbidden ? 403 : 409);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ transactionId: string }> },
) {
  try {
    requireSameOrigin(request);
    const { transactionId: rawTransactionId } = await context.params;
    const transactionId = requireUuid(rawTransactionId, "Payment transaction not found.");
    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      details?: unknown;
    } | null;
    const action = String(body?.action ?? "") as PaymentAction;
    if (!["deliver", "confirm", "report_issue", "escalate"].includes(action)) {
      throw new ApiError("Choose a valid campaign action.", 400);
    }
    const { profile, admin } = await requireAuthenticatedProfile();
    await enforcePaymentRateLimit(admin, {
      bucket: "payment_fulfillment_action",
      profileId: profile.id,
      maxRequests: 30,
      windowSeconds: 10 * 60,
    });

    if (action === "deliver") {
      const result = await admin.rpc("mark_campaign_delivered", {
        target_transaction_id: transactionId,
        actor_profile_id: profile.id,
      });
      if (result.error) actionError(result.error);
      return Response.json({ transaction: participantTransactionResponse(result.data) });
    }
    if (action === "confirm") {
      try {
        const result = await releasePendingPayout(admin, {
          transactionId,
          mode: "payer_confirmation",
          actorProfileId: profile.id,
        });
        return Response.json({
          alreadyReleased: result.alreadyReleased,
          transaction: participantTransactionResponse(result.transaction),
        });
      } catch (error) {
        actionError(error as { message?: string });
      }
    }
    if (action === "report_issue") {
      const details = String(body?.details ?? "").trim();
      if (details.length < 10 || details.length > 4000) {
        throw new ApiError("Describe the issue in 10 to 4,000 characters.", 400);
      }
      const result = await admin.rpc("report_campaign_issue", {
        target_transaction_id: transactionId,
        actor_profile_id: profile.id,
        issue_details: details,
      });
      if (result.error) actionError(result.error);
      return Response.json({ issue: result.data });
    }

    const result = await admin.rpc("escalate_campaign_issue", {
      target_transaction_id: transactionId,
      actor_profile_id: profile.id,
    });
    if (result.error) actionError(result.error);
    return Response.json({ issue: result.data });
  } catch (error) {
    return errorResponse(error);
  }
}

export const runtime = "nodejs";
