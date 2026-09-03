import {
  ApiError,
  errorResponse,
  requireAuthorizedPaymentsStaff,
  requireSameOrigin,
  requireUuid,
} from "@/lib/payments/auth";
import { releasePendingPayout } from "@/lib/payments/release";
import { getStripe } from "@/lib/stripe/server";
import { enforcePaymentRateLimit } from "@/lib/payments/rate-limit";
import { participantTransactionResponse } from "@/lib/payments/response";

type ResolutionAction = "release_payout" | "full_refund" | "partial_refund";

export async function POST(
  request: Request,
  context: { params: Promise<{ issueId: string }> },
) {
  try {
    requireSameOrigin(request);
    const { issueId: rawIssueId } = await context.params;
    const issueId = requireUuid(rawIssueId, "Payment issue not found.");
    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      refundAmountCents?: unknown;
      notes?: unknown;
    } | null;
    const action = String(body?.action ?? "") as ResolutionAction;
    if (!["release_payout", "full_refund", "partial_refund"].includes(action)) {
      throw new ApiError("Choose a valid staff resolution.", 400);
    }
    const { user, profile, admin } = await requireAuthorizedPaymentsStaff();
    await enforcePaymentRateLimit(admin, {
      bucket: "stripe_staff_resolution",
      profileId: profile.id,
      maxRequests: 10,
      windowSeconds: 60 * 60,
    });
    const { data: issue, error: issueError } = await admin
      .from("payment_issues")
      .select("id,transaction_id,status")
      .eq("id", issueId)
      .single();
    if (issueError || !issue) throw new ApiError("Payment issue not found.", 404);

    if (action === "release_payout") {
      const result = await releasePendingPayout(admin, {
        transactionId: issue.transaction_id,
        mode: "staff",
        staffAuthUserId: user.id,
      });
      return Response.json({
        alreadyReleased: result.alreadyReleased,
        transaction: participantTransactionResponse(result.transaction),
      });
    }

    const refundAmountCents =
      action === "partial_refund" ? Number(body?.refundAmountCents) : null;
    if (
      action === "partial_refund" &&
      (!Number.isSafeInteger(refundAmountCents) || (refundAmountCents ?? 0) <= 0)
    ) {
      throw new ApiError("Enter a positive partial-refund amount in cents.", 400);
    }
    const claimed = await admin.rpc("claim_issue_refund_resolution", {
      target_issue_id: issueId,
      staff_user_id: user.id,
      requested_action: action,
      requested_refund_cents: refundAmountCents,
      notes: String(body?.notes ?? "").trim(),
    });
    if (claimed.error) throw new ApiError(claimed.error.message, 409);
    const payload = claimed.data as unknown as {
      resolution: {
        id: string;
        refund_amount_cents: number;
        idempotency_key: string;
        stripe_refund_id: string | null;
        status: string;
        promo_refund_cents?: number;
      };
      transaction: { stripe_charge_id: string };
    };
    if (payload.resolution.status === "completed" && (payload.resolution.promo_refund_cents ?? 0) > 0) {
      return Response.json({ resolution: payload.resolution });
    }
    if (payload.resolution.stripe_refund_id) {
      return Response.json({ resolution: payload.resolution, duplicate: true });
    }

    try {
      const refund = await getStripe().refunds.create(
        {
          charge: payload.transaction.stripe_charge_id,
          amount: payload.resolution.refund_amount_cents,
          reason: "requested_by_customer",
          metadata: {
            sidespace_transaction_id: issue.transaction_id,
            sidespace_issue_id: issueId,
            sidespace_resolution_id: payload.resolution.id,
          },
        },
        { idempotencyKey: payload.resolution.idempotency_key },
      );
      const updated = await admin
        .from("payment_resolution_actions")
        .update({ stripe_refund_id: refund.id, last_error: null })
        .eq("id", payload.resolution.id)
        .or(`stripe_refund_id.is.null,stripe_refund_id.eq.${refund.id}`)
        .select("id,status,stripe_refund_id,refund_amount_cents")
        .single();
      if (updated.error) throw updated.error;
      return Response.json({ resolution: updated.data });
    } catch (error) {
      const recorded = await admin
        .from("payment_resolution_actions")
        .update({
          last_error: error instanceof Error ? error.message.slice(0, 1000) : "Refund failed",
        })
        .eq("id", payload.resolution.id);
      if (recorded.error) {
        console.error(
          "Could not record payment resolution failure",
          payload.resolution.id,
          recorded.error,
        );
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}

export const runtime = "nodejs";
