import type Stripe from "stripe";

import { getStripeAccountReadiness } from "@/lib/payments/connect";
import { releasePendingPayout } from "@/lib/payments/release";
import { checkoutPaymentLifecycle } from "@/lib/payments/workflow";
import { createAdminClient } from "@/lib/supabase/admin";
import { webhookClaimAction } from "@/lib/stripe/events";
import { getStripe, getStripeWebhookSecret } from "@/lib/stripe/server";
import { verifyStripeWebhookEvent } from "@/lib/stripe/webhook";

type AdminClient = ReturnType<typeof createAdminClient>;

function objectId(value: string | { id: string } | null | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

async function transactionByCharge(admin: AdminClient, chargeId: string) {
  const { data, error } = await admin
    .from("payment_transactions")
    .select(
      "id,campaign_request_id,customer_total_cents,tax_cents,status,workflow_status,payout_status,issue_status,delivered_at,review_deadline,stripe_transfer_id,dispute_status",
    )
    .eq("stripe_charge_id", chargeId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function syncCheckoutSession(
  admin: AdminClient,
  sessionId: string,
  forcedStatus?: "payment_failed" | "expired",
) {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent.latest_charge"],
  });
  if (session.livemode) throw new Error("Live-mode session received by sandbox webhook.");

  const transactionId = session.metadata?.sidespace_transaction_id;
  if (!transactionId) throw new Error("Checkout Session is missing its transaction ID.");
  const { data: storedTransaction, error: storedError } = await admin
    .from("payment_transactions")
    .select(
      "id,campaign_request_id,customer_total_cents,status,dispute_status,stripe_checkout_session_id,stripe_connected_account_id,stripe_transfer_id,payout_status,workflow_status,issue_status,stripe_tax_transfer_reversal_id,paid_at",
    )
    .eq("id", transactionId)
    .single();
  if (storedError) throw storedError;
  if (!storedTransaction) throw new Error("Payment transaction was not found.");
  if (
    storedTransaction.stripe_checkout_session_id &&
    storedTransaction.stripe_checkout_session_id !== session.id
  ) {
    throw new Error("Checkout Session does not match the stored transaction.");
  }
  if (session.amount_subtotal !== storedTransaction.customer_total_cents) {
    throw new Error("Checkout Session amount does not match the stored ledger.");
  }
  const paymentIntent =
    typeof session.payment_intent === "object" ? session.payment_intent : null;
  const latestCharge =
    paymentIntent && typeof paymentIntent.latest_charge === "object"
      ? paymentIntent.latest_charge
      : null;

  const paid =
    session.payment_status === "paid" ||
    session.payment_status === "no_payment_required";
  if (paid && (!paymentIntent || !latestCharge)) {
    throw new Error("Paid Checkout Session is missing expanded charge data.");
  }

  if (
    paymentIntent &&
    paymentIntent.transfer_group !== `sidespace_campaign_${transactionId}`
  ) {
    throw new Error("Payment transfer group does not match the stored transaction.");
  }

  const refundedCents = latestCharge?.amount_refunded ?? 0;
  let status: string = "processing";
  if (
    storedTransaction.status === "disputed" &&
    storedTransaction.dispute_status !== "won"
  ) {
    status = "disputed";
  } else if (latestCharge?.disputed) {
    status = "disputed";
  } else if (paid && latestCharge && refundedCents >= latestCharge.amount) {
    status = "refunded";
  } else if (paid && refundedCents > 0) {
    status = "partially_refunded";
  } else if (paid) {
    status = "paid";
  } else if (forcedStatus) {
    status = forcedStatus;
  } else if (session.status === "expired") {
    status = "expired";
  }

  const taxCents = session.total_details?.amount_tax ?? 0;
  // New Checkouts are platform charges and therefore have no automatic
  // destination transfer. Preserve an existing legacy transfer if this event
  // belongs to a pre-migration destination charge, but never create one here.
  const legacyTransferId = objectId(latestCharge?.transfer);
  const lifecycle = checkoutPaymentLifecycle({
    paid,
    legacyTransferId,
    payoutStatus: storedTransaction.payout_status,
    workflowStatus: storedTransaction.workflow_status,
  });
  const update = {
    status,
    stripe_checkout_session_id: session.id,
    tax_cents: taxCents,
    refunded_cents: refundedCents,
    stripe_customer_id: objectId(session.customer),
    stripe_payment_intent_id: objectId(session.payment_intent),
    stripe_charge_id: latestCharge?.id ?? null,
    stripe_transfer_id: storedTransaction.stripe_transfer_id ?? legacyTransferId,
    // Platform charges retain collected tax on the platform balance without a
    // destination-transfer reversal. This column remains for legacy records.
    stripe_tax_transfer_reversal_id:
      storedTransaction.stripe_tax_transfer_reversal_id,
    tax_withheld_cents: taxCents,
    stripe_application_fee_id: objectId(latestCharge?.application_fee),
    stripe_invoice_id: objectId(session.invoice),
    paid_at: paid
      ? storedTransaction.paid_at ?? new Date().toISOString()
      : storedTransaction.paid_at,
    payout_status: lifecycle.payoutStatus,
    workflow_status: lifecycle.workflowStatus,
    payout_released_at: legacyTransferId
      ? storedTransaction.paid_at ?? new Date().toISOString()
      : undefined,
  };
  const { data: transaction, error } = await admin
    .from("payment_transactions")
    .update(update)
    .eq("id", transactionId)
    .or(
      `stripe_checkout_session_id.is.null,stripe_checkout_session_id.eq.${session.id}`,
    )
    .select("campaign_request_id")
    .single();
  if (error) throw error;

  if (lifecycle.movesToPaidWorkflow) {
    const { error: eventError } = await admin
      .from("payment_fulfillment_events")
      .insert({
        transaction_id: transactionId,
        actor_kind: "stripe",
        event_type: "payment_verified",
        from_state: storedTransaction.workflow_status,
        to_state: legacyTransferId ? "completed" : "paid_payout_pending",
        metadata: { checkout_session_id: session.id },
      });
    if (eventError) throw eventError;
  }

  if (["paid", "partially_refunded"].includes(status)) {
    const { error: campaignError } = await admin
      .from("campaign_requests")
      .update({ status: "confirmed" })
      .eq("id", transaction.campaign_request_id)
      .in("status", ["accepted", "confirmed"]);
    if (campaignError) throw campaignError;
  } else if (status === "refunded") {
    const { error: campaignError } = await admin
      .from("campaign_requests")
      .update({ status: "refunded" })
      .eq("id", transaction.campaign_request_id);
    if (campaignError) throw campaignError;
  } else if (status === "disputed") {
    const { error: campaignError } = await admin
      .from("campaign_requests")
      .update({ status: "disputed" })
      .eq("id", transaction.campaign_request_id);
    if (campaignError) throw campaignError;
  }
}

async function syncRefund(admin: AdminClient, refund: Stripe.Refund) {
  const chargeId = objectId(refund.charge);
  if (!chargeId) return;
  const stripe = getStripe();
  const charge = await stripe.charges.retrieve(chargeId);
  let transaction = await transactionByCharge(admin, chargeId);
  if (!transaction) {
    const paymentIntentId = objectId(charge.payment_intent);
    const transactionId = charge.metadata?.sidespace_transaction_id;
    let lookup = admin
      .from("payment_transactions")
      .select(
        "id,campaign_request_id,customer_total_cents,tax_cents,status,workflow_status,payout_status,issue_status,delivered_at,review_deadline,stripe_transfer_id,dispute_status",
      );
    lookup = transactionId
      ? lookup.eq("id", transactionId)
      : lookup.eq("stripe_payment_intent_id", paymentIntentId ?? "missing");
    const fallback = await lookup.maybeSingle();
    if (fallback.error) throw fallback.error;
    transaction = fallback.data;
    if (!transaction && transactionId) {
      throw new Error("Refund references a missing SideSpace transaction.");
    }
    if (transaction) {
      const { error } = await admin
        .from("payment_transactions")
        .update({
          stripe_charge_id: charge.id,
          stripe_payment_intent_id: paymentIntentId,
        })
        .eq("id", transaction.id);
      if (error) throw error;
    }
  }
  if (!transaction) return;

  if (transaction.payout_status === "releasing") {
    throw new Error("Payout release is in progress; retry this refund event.");
  }

  const { error: refundError } = await admin.from("payment_refunds").upsert({
    stripe_refund_id: refund.id,
    transaction_id: transaction.id,
    amount_cents: refund.amount,
    status: refund.status ?? "pending",
    reason: refund.reason,
  });
  if (refundError) throw refundError;

  const refundedCents = charge.amount_refunded;
  const fullAmount = charge.amount;
  const status =
    transaction.status === "disputed"
      ? "disputed"
      : refundedCents === 0
        ? "paid"
        : refundedCents >= fullAmount
          ? "refunded"
          : "partially_refunded";
  const payoutReleased = transaction.payout_status === "released";
  const { error } = await admin
    .from("payment_transactions")
    .update({
      status,
      refunded_cents: refundedCents,
      workflow_status:
        status === "refunded"
          ? "refunded"
          : status === "partially_refunded"
            ? "partially_refunded"
            : transaction.workflow_status,
      payout_status: payoutReleased
        ? "released"
        : status === "refunded"
          ? "refunded"
          : status === "partially_refunded"
            ? "blocked"
            : transaction.payout_status,
    })
    .eq("id", transaction.id);
  if (error) throw error;

  if (status === "refunded") {
    const { error: campaignError } = await admin
      .from("campaign_requests")
      .update({ status: "refunded" })
      .eq("id", transaction.campaign_request_id);
    if (campaignError) throw campaignError;
  } else if (status === "paid") {
    const { error: campaignError } = await admin
      .from("campaign_requests")
      .update({ status: "confirmed" })
      .eq("id", transaction.campaign_request_id)
      .in("status", ["accepted", "confirmed", "refunded"]);
    if (campaignError) throw campaignError;
  }

  const resolutionId = refund.metadata?.sidespace_resolution_id;
  if (resolutionId) {
    const { data: resolution, error: resolutionError } = await admin
      .from("payment_resolution_actions")
      .select("id,issue_id,transaction_id,action,status")
      .eq("id", resolutionId)
      .eq("transaction_id", transaction.id)
      .single();
    if (resolutionError || !resolution) {
      throw resolutionError ?? new Error("Refund resolution record is missing.");
    }
    if (refund.status === "failed" || refund.status === "canceled") {
      await admin
        .from("payment_resolution_actions")
        .update({ status: "failed", completed_at: new Date().toISOString() })
        .eq("id", resolution.id);
      await admin
        .from("payment_issues")
        .update({ status: "escalated" })
        .eq("id", resolution.issue_id);
      await admin
        .from("payment_transactions")
        .update({
          issue_status: "escalated",
          workflow_status: "issue_escalated",
          payout_status: "blocked",
        })
        .eq("id", transaction.id);
    } else if (refund.status === "succeeded") {
      await admin
        .from("payment_resolution_actions")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", resolution.id);
      if (resolution.action === "full_refund") {
        await admin
          .from("payment_issues")
          .update({ status: "resolved", resolved_at: new Date().toISOString() })
          .eq("id", resolution.issue_id);
        await admin
          .from("payment_transactions")
          .update({
            issue_status: "resolved",
            workflow_status: "refunded",
            payout_status: "refunded",
          })
          .eq("id", transaction.id);
      } else {
        await admin
          .from("payment_transactions")
          .update({ payout_status: "partially_refunded" })
          .eq("id", transaction.id);
        await releasePendingPayout(admin, {
          transactionId: transaction.id,
          mode: "partial_refund_resolution",
        });
      }
    }
  }
}

async function syncDispute(admin: AdminClient, dispute: Stripe.Dispute) {
  const chargeId = objectId(dispute.charge);
  if (!chargeId) return;
  const stripe = getStripe();
  const charge = await stripe.charges.retrieve(chargeId);
  let transaction = await transactionByCharge(admin, chargeId);
  if (!transaction) {
    const paymentIntentId = objectId(charge.payment_intent);
    const transactionId = charge.metadata?.sidespace_transaction_id;
    let lookup = admin
      .from("payment_transactions")
      .select(
        "id,campaign_request_id,customer_total_cents,tax_cents,status,workflow_status,payout_status,issue_status,delivered_at,review_deadline,stripe_transfer_id,dispute_status",
      );
    lookup = transactionId
      ? lookup.eq("id", transactionId)
      : lookup.eq("stripe_payment_intent_id", paymentIntentId ?? "missing");
    const fallback = await lookup.maybeSingle();
    if (fallback.error) throw fallback.error;
    transaction = fallback.data;
    if (!transaction && transactionId) {
      throw new Error("Dispute references a missing SideSpace transaction.");
    }
    if (transaction) {
      const { error } = await admin
        .from("payment_transactions")
        .update({
          stripe_charge_id: charge.id,
          stripe_payment_intent_id: paymentIntentId,
        })
        .eq("id", transaction.id);
      if (error) throw error;
    }
  }
  if (!transaction) return;

  if (transaction.payout_status === "releasing") {
    throw new Error("Payout release is in progress; retry this dispute event.");
  }

  const { error: disputeError } = await admin.from("payment_disputes").upsert({
    stripe_dispute_id: dispute.id,
    transaction_id: transaction.id,
    amount_cents: dispute.amount,
    status: dispute.status,
    reason: dispute.reason,
  });
  if (disputeError) throw disputeError;

  const won = dispute.status === "won";
  const refundedCents = charge.amount_refunded;
  const resolvedStatus =
    refundedCents >= charge.amount
      ? "refunded"
      : refundedCents > 0
        ? "partially_refunded"
        : "paid";
  const transactionStatus = won ? resolvedStatus : "disputed";
  const nextPayoutStatus = won
    ? transaction.payout_status === "released"
      ? "released"
      : resolvedStatus === "refunded"
        ? "refunded"
        : "pending"
    : transaction.payout_status === "released"
      ? "released"
      : "disputed";
  const nextWorkflowStatus = won
    ? resolvedStatus === "refunded"
      ? "refunded"
      : transaction.payout_status === "released"
        ? "completed"
        : transaction.delivered_at
          ? "awaiting_payer_review"
          : "paid_payout_pending"
    : "disputed";
  const { error } = await admin
    .from("payment_transactions")
    .update({
      status: transactionStatus,
      refunded_cents: refundedCents,
      dispute_status: dispute.status,
      payout_status: nextPayoutStatus,
      workflow_status: nextWorkflowStatus,
    })
    .eq("id", transaction.id);
  if (error) throw error;
  const { error: campaignError } = await admin
    .from("campaign_requests")
    .update({
      status:
        won && resolvedStatus === "refunded"
          ? "refunded"
          : won
            ? "confirmed"
            : "disputed",
    })
    .eq("id", transaction.campaign_request_id);
  if (campaignError) throw campaignError;
}

async function syncConnectedAccount(admin: AdminClient, account: Stripe.Account) {
  const { requirementsDue, ready } = getStripeAccountReadiness(account);
  const { error } = await admin
    .from("stripe_accounts")
    .update({
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      requirements_due: requirementsDue,
      onboarding_completed_at: ready ? new Date().toISOString() : null,
    })
    .eq("stripe_connected_account_id", account.id);
  if (error) throw error;
}

async function processEvent(admin: AdminClient, event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await syncCheckoutSession(admin, event.data.object.id);
      break;
    case "checkout.session.async_payment_failed":
      await syncCheckoutSession(admin, event.data.object.id, "payment_failed");
      break;
    case "checkout.session.expired":
      await syncCheckoutSession(admin, event.data.object.id, "expired");
      break;
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
      await syncRefund(admin, event.data.object);
      break;
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      await syncDispute(admin, event.data.object);
      break;
    case "account.updated":
      await syncConnectedAccount(admin, event.data.object);
      break;
    default:
      break;
  }
}

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "Stripe signature is required." }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const payload = await request.text();
    event = verifyStripeWebhookEvent(
      getStripe(),
      payload,
      signature,
      getStripeWebhookSecret(),
    );
  } catch {
    return Response.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }
  const admin = createAdminClient();
  const inserted = await admin.from("stripe_webhook_events").insert({
    stripe_event_id: event.id,
    event_type: event.type,
    livemode: event.livemode,
  });
  if (inserted.error) {
    if (inserted.error.code !== "23505") throw inserted.error;
    const { data: prior } = await admin
      .from("stripe_webhook_events")
      .select("status,attempts,received_at")
      .eq("stripe_event_id", event.id)
      .maybeSingle();
    if (!prior) throw inserted.error;
    const claimAction = webhookClaimAction(
      {
        status: prior.status,
        receivedAt: new Date(prior.received_at).getTime(),
      },
      Date.now(),
    );
    if (claimAction === "duplicate") {
      return Response.json({ received: true, duplicate: true });
    }
    if (claimAction === "busy") {
      return Response.json(
        { error: "This event is already being processed." },
        { status: 409 },
      );
    }
    const reclaimed = await admin
      .from("stripe_webhook_events")
      .update({
        status: "processing",
        attempts: prior.attempts + 1,
        last_error: null,
        received_at: new Date().toISOString(),
      })
      .eq("stripe_event_id", event.id)
      .eq("status", prior.status)
      .eq("attempts", prior.attempts)
      .select("stripe_event_id")
      .maybeSingle();
    if (reclaimed.error) throw reclaimed.error;
    if (!reclaimed.data) {
      return Response.json(
        { error: "This event was claimed by another request." },
        { status: 409 },
      );
    }
  }

  try {
    await processEvent(admin, event);
    const { error } = await admin
      .from("stripe_webhook_events")
      .update({
        status: "processed",
        processed_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("stripe_event_id", event.id);
    if (error) throw error;
    return Response.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing failed", event.id, event.type, error);
    await admin
      .from("stripe_webhook_events")
      .update({
        status: "failed",
        last_error: error instanceof Error ? error.message.slice(0, 1000) : "Unknown error",
      })
      .eq("stripe_event_id", event.id);
    return Response.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}

export const runtime = "nodejs";
