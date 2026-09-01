import { recoverReleasedPayout } from "@/lib/payments/recovery";
import { releasePendingPayout } from "@/lib/payments/release";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/server";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Cron authorization is required." }, { status: 401 });
  }
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const staleClaim = new Date(Date.now() - 15 * 60_000).toISOString();
  const [dueResult, stuckResult, partialRefundResult, recoveryResult, staleRecoveryResult] = await Promise.all([
    admin
    .from("payment_transactions")
    .select("id")
    .eq("payout_status", "pending")
    .eq("issue_status", "none")
    .eq("workflow_status", "awaiting_payer_review")
    .lte("review_deadline", now)
    .order("review_deadline", { ascending: true })
    .limit(50),
    admin
      .from("payment_transactions")
      .select("id")
      .eq("payout_status", "releasing")
      .lte("payout_release_claimed_at", staleClaim)
      .order("payout_release_claimed_at", { ascending: true })
      .limit(50),
    admin
      .from("payment_transactions")
      .select("id")
      .eq("payout_status", "blocked")
      .eq("payout_release_reason", "partial_refund_resolution")
      .eq("issue_status", "resolution_pending")
      .eq("workflow_status", "partially_refunded")
      .order("updated_at", { ascending: true })
      .limit(50),
    admin
      .from("payment_transfer_reversals")
      .select("transaction_id,target_amount_cents,reason")
      .in("status", ["pending", "failed"])
      .lte("next_attempt_at", now)
      .order("next_attempt_at", { ascending: true })
      .limit(50),
    admin
      .from("payment_transfer_reversals")
      .select("transaction_id,target_amount_cents,reason")
      .eq("status", "processing")
      .lte("claimed_at", staleClaim)
      .order("claimed_at", { ascending: true })
      .limit(50),
  ]);
  if (dueResult.error) throw dueResult.error;
  if (stuckResult.error) throw stuckResult.error;
  if (partialRefundResult.error) throw partialRefundResult.error;
  if (recoveryResult.error) throw recoveryResult.error;
  if (staleRecoveryResult.error) throw staleRecoveryResult.error;
  const candidates = [
    ...(dueResult.data ?? []).map(({ id }) => ({ id, mode: "automatic" as const })),
    ...(stuckResult.data ?? []).map(({ id }) => ({ id, mode: "automatic" as const })),
    ...(partialRefundResult.data ?? []).map(({ id }) => ({
      id,
      mode: "partial_refund_resolution" as const,
    })),
  ].filter(
    (item, index, rows) => rows.findIndex((row) => row.id === item.id) === index,
  );

  const results = await Promise.allSettled(
    candidates.map((transaction) =>
      releasePendingPayout(admin, {
        transactionId: transaction.id,
        mode: transaction.mode,
      }),
    ),
  );
  const failed = results
    .map((result, index) => ({ result, transactionId: candidates[index]?.id }))
    .filter(
      (item): item is {
        result: PromiseRejectedResult;
        transactionId: string;
      } => item.result.status === "rejected" && Boolean(item.transactionId),
    )
    .map((item) => ({
      transactionId: item.transactionId,
      error:
        item.result.reason instanceof Error
          ? item.result.reason.message
          : "Payout release failed.",
    }));

  const recoveryCandidates = [
    ...(recoveryResult.data ?? []),
    ...(staleRecoveryResult.data ?? []),
  ].filter(
    (item, index, rows) =>
      rows.findIndex((row) => row.transaction_id === item.transaction_id) === index,
  );
  const recoveryResults = await Promise.allSettled(
    recoveryCandidates.map((recovery) =>
      recoverReleasedPayout(admin, {
        transactionId: recovery.transaction_id,
        targetReversalCents: recovery.target_amount_cents,
        reason: recovery.reason,
      }),
    ),
  );
  const recoveryFailures = recoveryResults
    .map((result, index) => ({ result, transactionId: recoveryCandidates[index]?.transaction_id }))
    .filter(
      (item): item is {
        result: PromiseRejectedResult;
        transactionId: string;
      } => item.result.status === "rejected" && Boolean(item.transactionId),
    )
    .map((item) => ({
      transactionId: item.transactionId,
      error:
        item.result.reason instanceof Error
          ? item.result.reason.message
          : "Transfer recovery failed.",
    }));

  // Reconcile recently released payouts against Stripe rather than trusting
  // that a stored transfer ID necessarily represents the intended money flow.
  const releasedSince = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const released = await admin
    .from("payment_transactions")
    .select(
      "id,stripe_transfer_id,stripe_connected_account_id,stripe_charge_id,payout_amount_cents,payout_recovery_reversed_cents,currency",
    )
    .eq("payout_status", "released")
    .gte("payout_released_at", releasedSince)
    .order("payout_released_at", { ascending: false })
    .limit(100);
  if (released.error) throw released.error;
  const stripe = getStripe();
  const transferChecks = await Promise.allSettled(
    (released.data ?? []).map(async (transaction) => {
      if (!transaction.stripe_transfer_id || !transaction.stripe_charge_id) {
        throw new Error(`${transaction.id}: released payout is missing Stripe identifiers`);
      }
      const transfer = await stripe.transfers.retrieve(transaction.stripe_transfer_id);
      const destination =
        typeof transfer.destination === "string"
          ? transfer.destination
          : transfer.destination?.id;
      const sourceTransaction =
        typeof transfer.source_transaction === "string"
          ? transfer.source_transaction
          : transfer.source_transaction?.id;
      if (
        transfer.amount !== transaction.payout_amount_cents ||
        transfer.amount_reversed !== transaction.payout_recovery_reversed_cents ||
        transfer.currency !== transaction.currency ||
        destination !== transaction.stripe_connected_account_id ||
        sourceTransaction !== transaction.stripe_charge_id ||
        transfer.transfer_group !== `sidespace_campaign_${transaction.id}`
      ) {
        throw new Error(`${transaction.id}: Stripe transfer does not match the SideSpace ledger`);
      }
      return transaction.id;
    }),
  );
  const reconciliationFailures = transferChecks.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            transactionId: released.data?.[index]?.id,
            error:
              result.reason instanceof Error
                ? result.reason.message
                : "Payout reconciliation failed.",
          },
        ]
      : [],
  );
  const failures = [...failed, ...recoveryFailures, ...reconciliationFailures];
  return Response.json(
    {
      checked: candidates.length,
      released: results.length - failed.length,
      recoveryChecked: recoveryResults.length,
      recovered: recoveryResults.length - recoveryFailures.length,
      transfersReconciled: transferChecks.length - reconciliationFailures.length,
      failed: failures,
    },
    { status: failures.length ? 500 : 200 },
  );
}

export const runtime = "nodejs";
