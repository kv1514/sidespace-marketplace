import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/server";

function authorized(request: Request) {
  const secret = process.env.PAYMENTS_MONITORING_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

async function count(
  label: string,
  query: PromiseLike<{ count: number | null; error: { message?: string } | null }>,
) {
  const result = await query;
  if (result.error) {
    const details = JSON.stringify(result.error);
    throw new Error(
      `Payment health query failed (${label}): ${result.error.message || details || "unknown error"}`,
    );
  }
  return result.count ?? 0;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Monitoring authorization is required." }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60_000).toISOString();
    const now = new Date().toISOString();
    // Keep monitoring pressure low on Supabase's transaction pool. These
    // queries are tiny, but firing all of them at once can make PostgREST
    // abort an otherwise valid count request under production load.
    const failedWebhooks = await count(
          "failedWebhooksLastHour",
          admin
            .from("stripe_webhook_events")
            .select("stripe_event_id", { count: "exact", head: true })
            .eq("status", "failed")
            .gte("received_at", oneHourAgo),
        );
    const staleWebhooks = await count(
          "staleWebhookClaims",
          admin
            .from("stripe_webhook_events")
            .select("stripe_event_id", { count: "exact", head: true })
            .eq("status", "processing")
            .lte("received_at", fiveMinutesAgo),
        );
    const stuckPayouts = await count(
          "stuckPayoutReleases",
          admin
            .from("payment_transactions")
            .select("id", { count: "exact", head: true })
            .eq("payout_status", "releasing")
            .lte("payout_release_claimed_at", fifteenMinutesAgo),
        );
    const overduePayouts = await count(
          "overduePayouts",
          admin
            .from("payment_transactions")
            .select("id", { count: "exact", head: true })
            .eq("payout_status", "pending")
            .eq("issue_status", "none")
            .eq("workflow_status", "awaiting_payer_review")
            .lte("review_deadline", now),
        );
    const activeDisputes = await count(
          "activeDisputes",
          admin
            .from("payment_transactions")
            .select("id", { count: "exact", head: true })
            .eq("status", "disputed")
            // NULL means Stripe's dispute state is incomplete, so it must
            // remain visible to monitoring instead of being excluded by SQL
            // three-valued NOT IN semantics.
            .or("dispute_status.is.null,dispute_status.not.in.(won,lost)"),
        );
    const postPayoutRecoveries = await count(
          "postPayoutRecoveries",
          admin
            .from("payment_transactions")
            .select("id", { count: "exact", head: true })
            .eq("payout_status", "released")
            .in("status", ["refunded", "partially_refunded", "disputed"])
            .neq("payout_recovery_status", "recovered"),
        );
    const pendingRefundResolutions = await count(
          "pendingRefundResolutions",
          admin
            .from("payment_transactions")
            .select("id", { count: "exact", head: true })
            .eq("workflow_status", "refund_pending")
            .lte("updated_at", fifteenMinutesAgo),
        );
    const stuckPartialRefundPayouts = await count(
          "stuckPartialRefundPayouts",
          admin
            .from("payment_transactions")
            .select("id", { count: "exact", head: true })
            .eq("payout_status", "blocked")
            .eq("payout_release_reason", "partial_refund_resolution")
            .eq("issue_status", "resolution_pending")
            .eq("workflow_status", "partially_refunded")
            .lte("updated_at", fifteenMinutesAgo),
        );
    const unexpectedPartialRefunds = await count(
          "unexpectedPartialRefunds",
          admin
            .from("payment_transactions")
            .select("id", { count: "exact", head: true })
            .eq("status", "partially_refunded")
            .eq("payout_status", "blocked")
            // A partial refund outside the staff resolution flow must never
            // be auto-released, but it must become an operator alert. NULL
            // needs explicit inclusion because SQL != does not match NULL.
            .or("payout_release_reason.is.null,payout_release_reason.neq.partial_refund_resolution")
            .lte("updated_at", fifteenMinutesAgo),
        );

    await getStripe().balance.retrieve();
    const checks = {
      stripeApi: "reachable",
      failedWebhooksLastHour: failedWebhooks,
      staleWebhookClaims: staleWebhooks,
      stuckPayoutReleases: stuckPayouts,
      overduePayouts,
      activeDisputes,
      postPayoutRecoveries,
      pendingRefundResolutions,
      stuckPartialRefundPayouts,
      unexpectedPartialRefunds,
    };
    const healthy =
      failedWebhooks === 0 &&
      staleWebhooks === 0 &&
      stuckPayouts === 0 &&
      overduePayouts === 0 &&
      activeDisputes === 0 &&
      postPayoutRecoveries === 0 &&
      pendingRefundResolutions === 0 &&
      stuckPartialRefundPayouts === 0 &&
      unexpectedPartialRefunds === 0;
    return Response.json(
      { status: healthy ? "ready" : "attention_required", checks },
      { status: healthy ? 200 : 503 },
    );
  } catch (error) {
    console.error("Payment health check failed", error);
    return Response.json(
      { status: "unavailable", error: "Payment health checks could not complete." },
      { status: 503 },
    );
  }
}

export const runtime = "nodejs";
