import type Stripe from "stripe";

import { getStripeAccountReadiness } from "@/lib/payments/connect";
import {
  payoutRecoveryTargetCents,
  recoverReleasedPayout,
} from "@/lib/payments/recovery";
import { releasePendingPayout } from "@/lib/payments/release";
import {
  checkoutPaymentLifecycle,
  payoutAmountAfterRefund,
  payoutStatusAfterRefundResolution,
  restorePayoutAfterRefundFailure,
} from "@/lib/payments/workflow";
import { createAdminClient } from "@/lib/supabase/admin";
import { webhookClaimAction } from "@/lib/stripe/events";
import {
  getStripe,
  getStripeWebhookSecrets,
  stripeKeyMode,
} from "@/lib/stripe/server";
import {
  assertStripeCheckoutAmounts,
  assertStripeMoneyMatchesLedger,
  isStaleCheckoutSession,
  verifyStripeWebhookEventWithSecrets,
} from "@/lib/stripe/webhook";

type AdminClient = ReturnType<typeof createAdminClient>;

function objectId(value: string | { id: string } | null | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

async function transactionByCharge(admin: AdminClient, chargeId: string) {
  const { data, error } = await admin
    .from("payment_transactions")
    .select(
      "id,campaign_request_id,currency,customer_total_cents,ad_credit_cents,charged_total_cents,tax_cents,refunded_cents,status,workflow_status,payout_status,issue_status,delivered_at,review_deadline,stripe_transfer_id,stripe_connected_account_id,creator_payout_cents,payout_amount_cents,payout_recovery_status,payout_recovery_target_cents,payout_recovery_reversed_cents,dispute_status",
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
  if (session.livemode !== (stripeKeyMode() === "live")) {
    throw new Error("Checkout Session mode does not match the configured API keys.");
  }

  const transactionId = session.metadata?.sidespace_transaction_id;
  if (!transactionId) throw new Error("Checkout Session is missing its transaction ID.");
  const { data: storedTransaction, error: storedError } = await admin
    .from("payment_transactions")
    .select(
      "id,campaign_request_id,currency,customer_total_cents,ad_credit_cents,charged_total_cents,status,dispute_status,stripe_checkout_session_id,stripe_connected_account_id,stripe_transfer_id,payout_status,workflow_status,issue_status,stripe_tax_transfer_reversal_id,paid_at",
    )
    .eq("id", transactionId)
    .single();
  if (storedError) throw storedError;
  if (!storedTransaction) throw new Error("Payment transaction was not found.");
  if (
    isStaleCheckoutSession(
      storedTransaction.stripe_checkout_session_id,
      session.id,
    )
  ) {
    // A prior Checkout attempt can finish expiring after a newer attempt has
    // already claimed the ledger. It cannot be paid once Stripe marks it
    // expired, so treat its signed webhook as a successful no-op instead of
    // retrying it forever and keeping payment health red.
    return;
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
  const taxCents = session.total_details?.amount_tax ?? 0;
  const chargedTotalCents =
    storedTransaction.charged_total_cents ?? storedTransaction.customer_total_cents;
  assertStripeCheckoutAmounts({
    amountSubtotal: session.amount_subtotal,
    amountTotal: session.amount_total,
    chargedTotalCents,
    taxCents,
    paymentStatus: session.payment_status,
  });
  const fullyCredited = chargedTotalCents === 0 &&
    storedTransaction.ad_credit_cents > 0 &&
    storedTransaction.ad_credit_cents === storedTransaction.customer_total_cents;
  if (paid && fullyCredited) {
    if (session.status !== "complete" || session.payment_status !== "no_payment_required" ||
        session.amount_total !== 0 || taxCents !== 0 || session.payment_intent !== null ||
        session.currency !== storedTransaction.currency ||
        session.metadata?.sidespace_ad_credit_cents !== String(storedTransaction.ad_credit_cents)) {
      throw new Error("Free Checkout Session does not match the credited ledger.");
    }
    // A delayed completion event cannot revive an order whose promo credit
    // has already been refunded by staff.
    if (storedTransaction.status === "refunded") return;
  } else if (paid) {
    if (!paymentIntent || !latestCharge) {
      throw new Error("Paid Checkout Session is missing expanded charge data.");
    }
    const expectedAmountCents = chargedTotalCents + taxCents;
    assertStripeMoneyMatchesLedger({
      objectName: "PaymentIntent",
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      expectedAmountCents,
      expectedCurrency: storedTransaction.currency,
    });
    assertStripeMoneyMatchesLedger({
      objectName: "Charge",
      amount: latestCharge.amount,
      currency: latestCharge.currency,
      expectedAmountCents,
      expectedCurrency: storedTransaction.currency,
    });
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

  // New Checkouts are platform charges and therefore have no automatic
  // destination transfer. Preserve an existing legacy transfer if this event
  // belongs to a pre-migration destination charge, but never create one here.
  const legacyTransferId = objectId(latestCharge?.transfer);
  const lifecycle = checkoutPaymentLifecycle({
    paid,
    legacyTransferId,
    payoutStatus: storedTransaction.payout_status,
    workflowStatus: storedTransaction.workflow_status,
    terminalWorkflowStatus:
      forcedStatus ?? (status === "expired" ? "expired" : undefined),
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

  if (!paid && ["payment_failed", "expired"].includes(status)) {
    const { error: releaseError } = await admin.rpc(
      "release_business_ad_credit",
      { target_transaction_id: transactionId },
    );
    if (releaseError) throw releaseError;
  }

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
  const stripe = getStripe();
  const currentRefund = await stripe.refunds.retrieve(refund.id);
  const chargeId = objectId(currentRefund.charge);
  if (!chargeId) return;
  const charge = await stripe.charges.retrieve(chargeId);
  let transaction = await transactionByCharge(admin, chargeId);
  if (!transaction) {
    const paymentIntentId = objectId(charge.payment_intent);
    const transactionId = charge.metadata?.sidespace_transaction_id;
    let lookup = admin
      .from("payment_transactions")
      .select(
        "id,campaign_request_id,currency,customer_total_cents,ad_credit_cents,charged_total_cents,tax_cents,refunded_cents,status,workflow_status,payout_status,issue_status,delivered_at,review_deadline,stripe_transfer_id,stripe_connected_account_id,creator_payout_cents,payout_amount_cents,payout_recovery_status,payout_recovery_target_cents,payout_recovery_reversed_cents,dispute_status",
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

  assertStripeMoneyMatchesLedger({
    objectName: "Charge",
    amount: charge.amount,
    currency: charge.currency,
    expectedAmountCents:
      (transaction.charged_total_cents ?? transaction.customer_total_cents) +
      transaction.tax_cents,
    expectedCurrency: transaction.currency,
  });

  if (transaction.payout_status === "releasing") {
    throw new Error("Payout release is in progress; retry this refund event.");
  }

  const { error: refundError } = await admin.from("payment_refunds").upsert({
    stripe_refund_id: currentRefund.id,
    transaction_id: transaction.id,
    amount_cents: currentRefund.amount,
    status: currentRefund.status ?? "pending",
    reason: currentRefund.reason,
  });
  if (refundError) throw refundError;

  const refundedCents = charge.amount_refunded;
  const fullAmount = charge.amount;
  const refundStatus = currentRefund.status ?? "pending";
  const refundPending = ["pending", "requires_action"].includes(refundStatus);
  const refundSucceeded = refundStatus === "succeeded";
  const refundFailed = ["failed", "canceled"].includes(refundStatus);
  const status =
    transaction.status === "disputed"
      ? "disputed"
      : refundedCents === 0
        ? "paid"
        : refundedCents >= fullAmount
          ? "refunded"
          : "partially_refunded";
  const payoutReleased = transaction.payout_status === "released";
  const refundFailedWithoutAdditionalAmount =
    !payoutReleased &&
    refundFailed &&
    refundedCents === (transaction.refunded_cents ?? 0);
  const restoredPayoutAmount = refundFailedWithoutAdditionalAmount
    ? payoutAmountAfterRefund({
        originalPayoutCents: transaction.creator_payout_cents,
        chargeAmountCents: fullAmount,
        refundedCents,
      })
    : null;
  const reconciledPayoutAmount =
    !payoutReleased && refundSucceeded && refundedCents > 0
      ? payoutAmountAfterRefund({
          originalPayoutCents: transaction.creator_payout_cents,
          chargeAmountCents: fullAmount,
          refundedCents,
        })
      : null;
  const payoutAfterRefundFailure = restorePayoutAfterRefundFailure({
    nextStatus: status,
    refundStatus,
    refundedCents,
    currentPayoutStatus: transaction.payout_status,
    currentWorkflowStatus: transaction.workflow_status,
    issueStatus: transaction.issue_status,
    deliveredAt: transaction.delivered_at,
  });
  const { data: updatedTransaction, error } = await admin
    .from("payment_transactions")
    .update({
      status,
      refunded_cents: refundedCents,
      workflow_status: refundPending
        ? "refund_pending"
        : status === "refunded"
          ? "refunded"
          : status === "partially_refunded"
            ? "partially_refunded"
            : payoutAfterRefundFailure.workflowStatus,
      payout_status: payoutReleased
        ? "released"
        : refundPending
          ? "blocked"
          : status === "refunded"
            ? "refunded"
            : status === "partially_refunded"
              ? "blocked"
              : payoutAfterRefundFailure.payoutStatus,
      ...(restoredPayoutAmount === null && reconciledPayoutAmount === null
        ? {}
        : {
            payout_amount_cents:
              restoredPayoutAmount ?? reconciledPayoutAmount,
          }),
    })
    .eq("id", transaction.id)
    .eq("status", transaction.status)
    .eq("workflow_status", transaction.workflow_status)
    .eq("payout_status", transaction.payout_status)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!updatedTransaction) {
    throw new Error("Payment state changed; retry this refund event.");
  }

  if (refundSucceeded && refundedCents > 0) {
    const { error: creditError } = await admin.rpc(
      "restore_business_ad_credit_for_refund",
      {
        target_transaction_id: transaction.id,
        refund_reference: currentRefund.id,
        refunded_cents: refundedCents,
        charge_amount_cents: fullAmount,
      },
    );
    if (creditError) throw creditError;
  }

  if (status === "refunded" && refundSucceeded) {
    const { error: campaignError } = await admin
      .from("campaign_requests")
      .update({ status: "refunded" })
      .eq("id", transaction.campaign_request_id);
    if (campaignError) throw campaignError;
  } else if (status === "paid" && refundFailed && !payoutReleased) {
    const { error: campaignError } = await admin
      .from("campaign_requests")
      .update({ status: "confirmed" })
      .eq("id", transaction.campaign_request_id)
      .in("status", ["accepted", "confirmed", "refunded"]);
    if (campaignError) throw campaignError;
  }

  if (refundSucceeded && payoutReleased) {
    if (!transaction.stripe_transfer_id) {
      throw new Error("Released payout is missing its Stripe transfer for recovery.");
    }
    const targetReversalCents = payoutRecoveryTargetCents({
      originalPayoutCents: transaction.creator_payout_cents,
      releasedPayoutCents: transaction.payout_amount_cents,
      chargeAmountCents: fullAmount,
      refundedCents,
    });
    await recoverReleasedPayout(admin, {
      transactionId: transaction.id,
      targetReversalCents,
      reason: "refund",
    });
  }

  const resolutionId = currentRefund.metadata?.sidespace_resolution_id;
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
    if (currentRefund.status === "failed" || currentRefund.status === "canceled") {
      const resolutionUpdate = await admin
        .from("payment_resolution_actions")
        .update({ status: "failed", completed_at: new Date().toISOString() })
        .eq("id", resolution.id);
      if (resolutionUpdate.error) throw resolutionUpdate.error;
      const issueUpdate = await admin
        .from("payment_issues")
        .update({ status: "escalated" })
        .eq("id", resolution.issue_id);
      if (issueUpdate.error) throw issueUpdate.error;
      const transactionUpdate = await admin
        .from("payment_transactions")
        .update({
          issue_status: "escalated",
          workflow_status: "issue_escalated",
          payout_status: payoutReleased ? "released" : "blocked",
        })
        .eq("id", transaction.id);
      if (transactionUpdate.error) throw transactionUpdate.error;
    } else if (currentRefund.status === "succeeded") {
      const resolutionUpdate = await admin
        .from("payment_resolution_actions")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", resolution.id);
      if (resolutionUpdate.error) throw resolutionUpdate.error;
      if (resolution.action === "full_refund") {
        const issueUpdate = await admin
          .from("payment_issues")
          .update({ status: "resolved", resolved_at: new Date().toISOString() })
          .eq("id", resolution.issue_id);
        if (issueUpdate.error) throw issueUpdate.error;
        const transactionUpdate = await admin
          .from("payment_transactions")
          .update({
            issue_status: "resolved",
            workflow_status: "refunded",
            payout_status: payoutStatusAfterRefundResolution({
              payoutWasReleased: payoutReleased,
              action: "full_refund",
            }),
          })
          .eq("id", transaction.id);
        if (transactionUpdate.error) throw transactionUpdate.error;
      } else {
        const transactionUpdate = await admin
          .from("payment_transactions")
          .update({
            payout_status: payoutStatusAfterRefundResolution({
              payoutWasReleased: payoutReleased,
              action: "partial_refund",
            }),
          })
          .eq("id", transaction.id);
        if (transactionUpdate.error) throw transactionUpdate.error;
        if (!payoutReleased) {
          await releasePendingPayout(admin, {
            transactionId: transaction.id,
            mode: "partial_refund_resolution",
          });
        }
      }
    }
  }
}

async function syncDispute(admin: AdminClient, dispute: Stripe.Dispute) {
  const chargeId = objectId(dispute.charge);
  if (!chargeId) return;
  const stripe = getStripe();
  const charge = await stripe.charges.retrieve(chargeId);
  const currentDispute = await stripe.disputes.retrieve(dispute.id);
  let transaction = await transactionByCharge(admin, chargeId);
  if (!transaction) {
    const paymentIntentId = objectId(charge.payment_intent);
    const transactionId = charge.metadata?.sidespace_transaction_id;
    let lookup = admin
      .from("payment_transactions")
      .select(
        "id,campaign_request_id,currency,customer_total_cents,ad_credit_cents,charged_total_cents,tax_cents,refunded_cents,status,workflow_status,payout_status,issue_status,delivered_at,review_deadline,stripe_transfer_id,stripe_connected_account_id,creator_payout_cents,payout_amount_cents,payout_recovery_status,payout_recovery_target_cents,payout_recovery_reversed_cents,dispute_status",
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

  assertStripeMoneyMatchesLedger({
    objectName: "Charge",
    amount: charge.amount,
    currency: charge.currency,
    expectedAmountCents:
      (transaction.charged_total_cents ?? transaction.customer_total_cents) +
      transaction.tax_cents,
    expectedCurrency: transaction.currency,
  });

  if (transaction.payout_status === "releasing") {
    throw new Error("Payout release is in progress; retry this dispute event.");
  }

  const { error: disputeError } = await admin.from("payment_disputes").upsert({
    stripe_dispute_id: dispute.id,
    transaction_id: transaction.id,
    amount_cents: currentDispute.amount,
    status: currentDispute.status,
    reason: currentDispute.reason,
  });
  if (disputeError) throw disputeError;

  const won = currentDispute.status === "won";
  const refundedCents = charge.amount_refunded;
  const resolvedStatus =
    refundedCents >= charge.amount
      ? "refunded"
      : refundedCents > 0
        ? "partially_refunded"
        : "paid";
  const refundRequiresResolution =
    transaction.payout_status !== "released" && refundedCents > 0;
  const reconciledPayoutAmount = refundRequiresResolution
    ? payoutAmountAfterRefund({
        originalPayoutCents: transaction.creator_payout_cents,
        chargeAmountCents: charge.amount,
        refundedCents,
      })
    : null;
  const transactionStatus = won ? resolvedStatus : "disputed";
  const nextPayoutStatus = won
    ? transaction.payout_status === "released"
      ? "released"
      : resolvedStatus === "refunded"
        ? "refunded"
        : refundRequiresResolution
          ? "blocked"
          : "pending"
    : transaction.payout_status === "released"
      ? "released"
      : "disputed";
  const nextWorkflowStatus = won
    ? resolvedStatus === "refunded"
      ? "refunded"
      : transaction.payout_status === "released"
        ? "completed"
        : refundRequiresResolution
          ? "partially_refunded"
          : transaction.delivered_at
            ? "awaiting_payer_review"
            : "paid_payout_pending"
    : "disputed";
  const { data: updatedTransaction, error } = await admin
    .from("payment_transactions")
    .update({
      status: transactionStatus,
      refunded_cents: refundedCents,
      dispute_status: currentDispute.status,
      payout_status: nextPayoutStatus,
      workflow_status: nextWorkflowStatus,
      ...(reconciledPayoutAmount === null
        ? {}
        : { payout_amount_cents: reconciledPayoutAmount }),
    })
    .eq("id", transaction.id)
    .eq("status", transaction.status)
    .eq("workflow_status", transaction.workflow_status)
    .eq("payout_status", transaction.payout_status)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!updatedTransaction) {
    throw new Error("Payment state changed; retry this dispute event.");
  }

  if (won && refundedCents > 0) {
    const { error: creditError } = await admin.rpc(
      "restore_business_ad_credit_for_refund",
      {
        target_transaction_id: transaction.id,
        refund_reference: currentDispute.id,
        refunded_cents: refundedCents,
        charge_amount_cents: charge.amount,
      },
    );
    if (creditError) throw creditError;
  }

  const { error: campaignError } = await admin
    .from("campaign_requests")
    .update({
      status:
        won && resolvedStatus === "refunded"
          ? "refunded"
          : won
            ? transaction.payout_status === "released"
              ? "completed"
              : "confirmed"
            : "disputed",
    })
    .eq("id", transaction.campaign_request_id);
  if (campaignError) throw campaignError;

  if (currentDispute.status === "lost" && transaction.payout_status === "released") {
    if (!transaction.stripe_transfer_id) {
      throw new Error("Released payout is missing its Stripe transfer for recovery.");
    }
    const targetReversalCents = payoutRecoveryTargetCents({
      originalPayoutCents: transaction.creator_payout_cents,
      releasedPayoutCents: transaction.payout_amount_cents,
      chargeAmountCents: charge.amount,
      refundedCents,
      disputedCents: currentDispute.amount,
    });
    await recoverReleasedPayout(admin, {
      transactionId: transaction.id,
      targetReversalCents,
      reason: "dispute",
    });
  }
}

async function syncConnectedAccount(
  admin: AdminClient,
  account: Stripe.Account,
  livemode: boolean,
) {
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
    .eq("stripe_connected_account_id", account.id)
    .eq("livemode", livemode);
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
      await syncConnectedAccount(admin, event.data.object, event.livemode);
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
    event = verifyStripeWebhookEventWithSecrets(
      getStripe(),
      payload,
      signature,
      getStripeWebhookSecrets(),
      stripeKeyMode() === "live",
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
        { status: 409, headers: { "Retry-After": "15" } },
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
        { status: 409, headers: { "Retry-After": "15" } },
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
