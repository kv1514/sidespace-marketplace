import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getStripe } from "@/lib/stripe/server";

export type PayoutRecoveryReason = "refund" | "dispute";

export function payoutRecoveryTargetCents(input: {
  originalPayoutCents: number;
  releasedPayoutCents?: number;
  chargeAmountCents: number;
  refundedCents: number;
  disputedCents?: number;
}) {
  const releasedPayoutCents = input.releasedPayoutCents ?? input.originalPayoutCents;
  if (
    !Number.isSafeInteger(input.originalPayoutCents) ||
    input.originalPayoutCents < 0 ||
    !Number.isSafeInteger(releasedPayoutCents) ||
    releasedPayoutCents < 0 ||
    releasedPayoutCents > input.originalPayoutCents ||
    !Number.isSafeInteger(input.chargeAmountCents) ||
    input.chargeAmountCents <= 0 ||
    !Number.isSafeInteger(input.refundedCents) ||
    input.refundedCents < 0 ||
    !Number.isSafeInteger(input.disputedCents ?? 0) ||
    (input.disputedCents ?? 0) < 0
  ) {
    throw new Error("Invalid payment amounts for transfer recovery.");
  }

  const originalPayoutCents = BigInt(input.originalPayoutCents);
  const chargeAmountCents = BigInt(input.chargeAmountCents);
  const affectedCents = [
    chargeAmountCents,
    BigInt(input.refundedCents) + BigInt(input.disputedCents ?? 0),
  ].reduce((smallest, value) => (value < smallest ? value : smallest));
  const remainingPayoutCents =
    (originalPayoutCents * (chargeAmountCents - affectedCents)) /
    chargeAmountCents;
  const releasedPayout = BigInt(releasedPayoutCents);
  const target = Number(
    releasedPayout > remainingPayoutCents
      ? releasedPayout - remainingPayoutCents
      : BigInt(0),
  );
  if (!Number.isSafeInteger(target)) {
    throw new Error("The calculated transfer recovery exceeds safe integer cents.");
  }
  return target;
}

type RecoveryClaim = {
  should_process?: boolean;
  busy?: boolean;
  status?: string;
  recovery_id: string;
  transaction_id?: string;
  stripe_transfer_id?: string;
  stripe_charge_id?: string;
  payout_funding?: "charge" | "platform";
  currency?: string;
  stripe_connected_account_id?: string;
  payout_amount_cents?: number;
  target_amount_cents: number;
  idempotency_key?: string;
};

function stripeObjectId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id;
}

export async function recoverReleasedPayout(
  admin: SupabaseClient,
  input: {
    transactionId: string;
    targetReversalCents: number;
    reason: PayoutRecoveryReason;
  },
) {
  const queued = await admin.rpc("queue_campaign_transfer_reversal", {
    target_transaction_id: input.transactionId,
    target_reversal_cents: input.targetReversalCents,
    recovery_reason: input.reason,
  });
  if (queued.error) throw queued.error;
  const claim = queued.data as unknown as RecoveryClaim | null;
  if (!claim) {
    throw new Error("Transfer recovery did not return a recovery record.");
  }
  if (!claim.should_process) {
    return {
      alreadyRecovered: claim.status === "succeeded" || claim.status === "recovered",
      busy: claim.busy === true,
    };
  }
  if (!claim.recovery_id) {
    throw new Error("Transfer recovery did not return a recovery record.");
  }
  try {
    if (
      !claim.stripe_transfer_id ||
      (!claim.stripe_charge_id && claim.payout_funding !== "platform") ||
      !claim.currency ||
      !claim.stripe_connected_account_id ||
      !Number.isSafeInteger(claim.payout_amount_cents) ||
      !claim.idempotency_key
    ) {
      throw new Error("Transfer recovery is missing trusted Stripe ledger data.");
    }
    const stripe = getStripe();
    const transfer = await stripe.transfers.retrieve(claim.stripe_transfer_id);
    const destination = stripeObjectId(transfer.destination);
    if (
      transfer.amount !== claim.payout_amount_cents ||
      transfer.currency !== claim.currency ||
      destination !== claim.stripe_connected_account_id ||
      stripeObjectId(transfer.source_transaction) !== (claim.payout_funding === "platform" ? undefined : claim.stripe_charge_id) ||
      transfer.transfer_group !== `sidespace_campaign_${input.transactionId}`
    ) {
      throw new Error("Stripe transfer does not match the SideSpace recovery ledger.");
    }

    let reversalId: string | null = null;
    if (transfer.amount_reversed < claim.target_amount_cents) {
      const remainingCents = claim.target_amount_cents - transfer.amount_reversed;
      const reversal = await stripe.transfers.createReversal(
        claim.stripe_transfer_id,
        {
          amount: remainingCents,
          description: `SideSpace ${input.reason} recovery`,
          metadata: {
            sidespace_transaction_id: input.transactionId,
            sidespace_recovery_id: claim.recovery_id,
            sidespace_recovery_reason: input.reason,
          },
        },
        { idempotencyKey: claim.idempotency_key },
      );
      reversalId = reversal.id;
    }

    const reconciledTransfer = await stripe.transfers.retrieve(
      claim.stripe_transfer_id,
    );
    if (reconciledTransfer.amount_reversed < claim.target_amount_cents) {
      throw new Error("Stripe transfer reversal did not reach the required amount.");
    }
    const finalized = await admin.rpc("finalize_campaign_transfer_reversal", {
      target_reversal_id: claim.recovery_id,
      reversal_id: reversalId,
      reversed_amount_cents: reconciledTransfer.amount_reversed,
    });
    if (finalized.error) throw finalized.error;
    return {
      alreadyRecovered: false,
      busy: false,
      reversalId,
      reversedAmountCents: reconciledTransfer.amount_reversed,
    };
  } catch (error) {
    const failure = await admin.rpc("record_campaign_transfer_reversal_failure", {
      target_reversal_id: claim.recovery_id,
      error_message: error instanceof Error ? error.message : "Transfer recovery failed.",
    });
    if (failure.error) {
      console.error("Could not record transfer recovery failure", input.transactionId, failure.error);
    }
    throw error;
  }
}
