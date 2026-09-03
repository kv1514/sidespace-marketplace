import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transferRetrieve: vi.fn(),
  transferCreateReversal: vi.fn(),
}));

vi.mock("@/lib/stripe/server", () => ({
  getStripe: () => ({
    transfers: {
      retrieve: mocks.transferRetrieve,
      createReversal: mocks.transferCreateReversal,
    },
  }),
}));

import {
  payoutRecoveryTargetCents,
  recoverReleasedPayout,
} from "../lib/payments/recovery";

const transfer = {
  id: "tr_creator",
  amount: 9_500,
  amount_reversed: 0,
  currency: "usd",
  destination: "acct_creator",
  source_transaction: "ch_platform",
  transfer_group: "sidespace_campaign_transaction-1",
};

function adminWithRecoveryClaim(targetAmountCents = 905, platformFunded = false) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "queue_campaign_transfer_reversal") {
      return {
        data: {
          should_process: true,
          busy: false,
          status: "processing",
          recovery_id: "recovery-1",
          transaction_id: "transaction-1",
          stripe_transfer_id: "tr_creator",
          stripe_charge_id: "ch_platform",
          payout_funding: platformFunded ? "platform" : "charge",
          currency: "usd",
          stripe_connected_account_id: "acct_creator",
          payout_amount_cents: 9_500,
          target_amount_cents: targetAmountCents,
          idempotency_key: "sidespace-reversal-transaction-1-905",
        },
        error: null,
      };
    }
    if (name === "finalize_campaign_transfer_reversal") {
      return { data: { transaction: { payout_recovery_status: "recovered" } }, error: null };
    }
    return { data: null, error: null };
  });
  return { rpc };
}

describe("promo-funded transfer recovery", () => {
  beforeEach(() => vi.clearAllMocks());
  it("verifies and reverses a platform-funded transfer without expecting a source charge", async () => {
    mocks.transferRetrieve.mockResolvedValueOnce({ ...transfer, source_transaction: null }).mockResolvedValueOnce({ ...transfer, source_transaction: null, amount_reversed: 905 });
    mocks.transferCreateReversal.mockResolvedValue({ id: "trr_promo" });
    const admin = adminWithRecoveryClaim(905, true);
    await recoverReleasedPayout(admin as never, { transactionId: "transaction-1", targetReversalCents: 905, reason: "refund" });
    expect(admin.rpc).toHaveBeenCalledWith("finalize_campaign_transfer_reversal", expect.objectContaining({ reversed_amount_cents: 905 }));
  });
});

describe("released payout recovery math", () => {
  it("reverses the full Creator payout for a full refund", () => {
    expect(
      payoutRecoveryTargetCents({
        originalPayoutCents: 9_500,
        chargeAmountCents: 10_500,
        refundedCents: 10_500,
      }),
    ).toBe(9_500);
  });

  it("uses integer-cent pro-rata math for a partial refund", () => {
    expect(
      payoutRecoveryTargetCents({
        originalPayoutCents: 9_500,
        chargeAmountCents: 10_500,
        refundedCents: 1_000,
      }),
    ).toBe(905);
  });

  it("caps refund plus lost-dispute exposure at the original charge", () => {
    expect(
      payoutRecoveryTargetCents({
        originalPayoutCents: 9_500,
        chargeAmountCents: 10_500,
        refundedCents: 1_000,
        disputedCents: 10_000,
      }),
    ).toBe(9_500);
  });

  it("recovers only the incremental delta after a pre-payout partial refund", () => {
    expect(
      payoutRecoveryTargetCents({
        originalPayoutCents: 9_500,
        releasedPayoutCents: 8_595,
        chargeAmountCents: 10_500,
        refundedCents: 2_000,
      }),
    ).toBe(905);
  });
});

describe("idempotent released payout recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reverses only the unrecovered delta and finalizes the ledger", async () => {
    const admin = adminWithRecoveryClaim();
    mocks.transferRetrieve
      .mockResolvedValueOnce(transfer)
      .mockResolvedValueOnce({ ...transfer, amount_reversed: 905 });
    mocks.transferCreateReversal.mockResolvedValue({ id: "trr_creator" });

    await recoverReleasedPayout(admin as never, {
      transactionId: "transaction-1",
      targetReversalCents: 905,
      reason: "refund",
    });

    expect(mocks.transferCreateReversal).toHaveBeenCalledWith(
      "tr_creator",
      expect.objectContaining({ amount: 905 }),
      { idempotencyKey: "sidespace-reversal-transaction-1-905" },
    );
    expect(admin.rpc).toHaveBeenCalledWith(
      "finalize_campaign_transfer_reversal",
      expect.objectContaining({
        target_reversal_id: "recovery-1",
        reversal_id: "trr_creator",
        reversed_amount_cents: 905,
      }),
    );
  });

  it("does not create another reversal when Stripe already has enough reversed", async () => {
    const admin = adminWithRecoveryClaim();
    mocks.transferRetrieve
      .mockResolvedValueOnce({ ...transfer, amount_reversed: 905 })
      .mockResolvedValueOnce({ ...transfer, amount_reversed: 905 });

    await recoverReleasedPayout(admin as never, {
      transactionId: "transaction-1",
      targetReversalCents: 905,
      reason: "refund",
    });

    expect(mocks.transferCreateReversal).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledWith(
      "finalize_campaign_transfer_reversal",
      expect.objectContaining({
        reversal_id: null,
        reversed_amount_cents: 905,
      }),
    );
  });

  it.each([
    ["amount", { amount: 9_499 }],
    ["currency", { currency: "eur" }],
    ["destination", { destination: "acct_other" }],
    ["source charge", { source_transaction: "ch_other" }],
    ["transfer group", { transfer_group: "sidespace_campaign_other" }],
  ])("records a recovery failure when the transfer %s is not the ledger value", async (_field, drift) => {
    const admin = adminWithRecoveryClaim();
    mocks.transferRetrieve.mockResolvedValue({ ...transfer, ...drift });

    await expect(
      recoverReleasedPayout(admin as never, {
        transactionId: "transaction-1",
        targetReversalCents: 905,
        reason: "refund",
      }),
    ).rejects.toThrow(/recovery ledger/);
    expect(mocks.transferCreateReversal).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledWith(
      "record_campaign_transfer_reversal_failure",
      expect.objectContaining({ error_message: expect.stringMatching(/recovery ledger/) }),
    );
  });

  it("records a Stripe failure for the retry worker", async () => {
    const admin = adminWithRecoveryClaim();
    mocks.transferRetrieve.mockRejectedValue(new Error("insufficient balance"));

    await expect(
      recoverReleasedPayout(admin as never, {
        transactionId: "transaction-1",
        targetReversalCents: 905,
        reason: "dispute",
      }),
    ).rejects.toThrow("insufficient balance");
    expect(admin.rpc).toHaveBeenCalledWith(
      "record_campaign_transfer_reversal_failure",
      expect.objectContaining({
        target_reversal_id: "recovery-1",
        error_message: "insufficient balance",
      }),
    );
  });
});
