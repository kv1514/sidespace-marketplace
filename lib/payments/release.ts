import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

import { payoutTransferIdempotencyKey } from "./review";
import { getStripe } from "@/lib/stripe/server";

export type PayoutReleaseMode =
  | "payer_confirmation"
  | "automatic"
  | "staff"
  | "partial_refund_resolution";

type ClaimedTransaction = {
  id: string;
  currency: string;
  creator_profile_id: string;
  stripe_connected_account_id: string;
  stripe_charge_id: string | null;
  stripe_transfer_id: string | null;
  payout_amount_cents: number;
  payout_status: string;
  payout_funding?: "charge" | "platform";
  payout_funding_attempt?: number;
  charged_total_cents?: number;
  ad_credit_cents?: number;
  customer_total_cents?: number;
  paid_at?: string | null;
  stripe_checkout_session_id?: string | null;
};

type ReleaseClaim = {
  already_released?: boolean;
  should_transfer?: boolean;
  transaction: ClaimedTransaction;
};

function stripeObjectId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id;
}

function assertTrustedTransfer(
  transfer: Stripe.Transfer,
  transaction: ClaimedTransaction,
) {
  const destination = stripeObjectId(transfer.destination);
  const sourceTransaction = stripeObjectId(transfer.source_transaction);
  if (
    transfer.amount !== transaction.payout_amount_cents ||
    transfer.currency !== transaction.currency ||
    destination !== transaction.stripe_connected_account_id ||
    sourceTransaction !== (transaction.payout_funding === "platform" ? undefined : transaction.stripe_charge_id) ||
    transfer.transfer_group !== `sidespace_campaign_${transaction.id}`
  ) {
    throw new Error("Stripe transfer does not match the trusted payout ledger.");
  }
}

export async function releasePendingPayout(
  admin: SupabaseClient,
  input: {
    transactionId: string;
    mode: PayoutReleaseMode;
    actorProfileId?: string | null;
    staffAuthUserId?: string | null;
  },
) {
  const { data, error } = await admin.rpc("claim_campaign_payout_release", {
    target_transaction_id: input.transactionId,
    release_mode: input.mode,
    actor_profile_id: input.actorProfileId ?? null,
    staff_user_id: input.staffAuthUserId ?? null,
  });
  if (error) throw error;
  const claim = data as unknown as ReleaseClaim;
  if (!claim?.transaction) throw new Error("Payout release did not return a transaction.");
  if (claim.already_released) {
    return { transaction: claim.transaction, alreadyReleased: true };
  }

  const transaction = claim.transaction;
  try {
    const fullyCredited = transaction.payout_funding === "platform" &&
      transaction.charged_total_cents === 0 &&
      (transaction.ad_credit_cents ?? 0) > 0 &&
      transaction.ad_credit_cents === transaction.customer_total_cents &&
      Boolean(transaction.paid_at && transaction.stripe_checkout_session_id);
    if (!transaction.stripe_charge_id && !fullyCredited) {
      throw new Error("The verified platform charge is missing from the payout ledger.");
    }
    if (transaction.payout_amount_cents <= 0) {
      throw new Error("The Creator payout amount must be greater than zero.");
    }
    const stripe = getStripe();
    const transfer = await stripe.transfers.create(
      {
        amount: transaction.payout_amount_cents,
        currency: transaction.currency,
        destination: transaction.stripe_connected_account_id,
        // A source-backed transfer cannot exceed its charge. SideSpace funds
        // promo shortfalls from its available Stripe balance, retaining the
        // creator's full net payout and the same retry-safe transfer key.
        ...(transaction.payout_funding === "platform" ? {} : { source_transaction: transaction.stripe_charge_id! }),
        transfer_group: `sidespace_campaign_${transaction.id}`,
        metadata: {
          sidespace_transaction_id: transaction.id,
          sidespace_creator_profile_id: transaction.creator_profile_id,
          sidespace_release_reason: input.mode,
        },
      },
      { idempotencyKey: transaction.payout_funding === "platform"
        ? `${payoutTransferIdempotencyKey(transaction.id)}-platform-${transaction.payout_funding_attempt ?? 0}`
        : payoutTransferIdempotencyKey(transaction.id) },
    );
    assertTrustedTransfer(transfer, transaction);
    const finalized = await admin.rpc("finalize_campaign_payout_release", {
      target_transaction_id: transaction.id,
      transfer_id: transfer.id,
      transferred_amount_cents: transfer.amount,
    });
    if (finalized.error) throw finalized.error;
    return { transaction: finalized.data, transferId: transfer.id, alreadyReleased: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Stripe transfer error";
    const failure = error as { type?: string; code?: string; statusCode?: number } | null;
    // Only a definitive insufficient-balance rejection permits a fresh key.
    // Timeouts and unknown results always retry the original key to prevent
    // duplicate transfers. The DB compares the attempt before advancing it.
    const fundingRejected = transaction.payout_funding === "platform" &&
      failure?.type === "StripeInvalidRequestError" && failure.code === "balance_insufficient" && failure.statusCode === 400;
    const reset = fundingRejected
      ? await admin.rpc("record_platform_payout_funding_failure", {
        target_transaction_id: transaction.id,
        expected_attempt: transaction.payout_funding_attempt ?? 0,
        error_message: message,
      })
      : await admin.rpc("record_campaign_payout_release_failure", {
        target_transaction_id: transaction.id,
        error_message: message,
      });
    if (reset.error) {
      console.error("Could not record payout release failure", transaction.id, reset.error);
    }
    throw error;
  }
}
