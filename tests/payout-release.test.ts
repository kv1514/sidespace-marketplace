import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transferCreate: vi.fn(),
}));

vi.mock("@/lib/stripe/server", () => ({
  getStripe: () => ({ transfers: { create: mocks.transferCreate } }),
}));

import { releasePendingPayout } from "../lib/payments/release";

const transaction = {
  id: "transaction-1",
  currency: "usd",
  creator_profile_id: "creator-1",
  stripe_connected_account_id: "acct_creator",
  stripe_charge_id: "ch_platform",
  stripe_transfer_id: null,
  payout_amount_cents: 9_500,
  payout_status: "releasing",
};

function adminWithClaims(claim: Record<string, unknown>) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "claim_campaign_payout_release") {
      return { data: claim, error: null };
    }
    if (name === "finalize_campaign_payout_release") {
      return { data: { ...transaction, payout_status: "released" }, error: null };
    }
    return { data: null, error: null };
  });
  return { rpc };
}

describe("idempotent delayed payout release", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates one trusted separate transfer and finalizes it", async () => {
    mocks.transferCreate.mockResolvedValue({ id: "tr_creator", amount: 9_500 });
    const admin = adminWithClaims({
      already_released: false,
      should_transfer: true,
      transaction,
    });

    const result = await releasePendingPayout(admin as never, {
      transactionId: transaction.id,
      mode: "payer_confirmation",
      actorProfileId: "business-1",
    });

    expect(mocks.transferCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 9_500,
        currency: "usd",
        destination: "acct_creator",
        source_transaction: "ch_platform",
      }),
      { idempotencyKey: "sidespace-payout-transaction-1" },
    );
    expect(admin.rpc).toHaveBeenCalledWith(
      "finalize_campaign_payout_release",
      expect.objectContaining({ transfer_id: "tr_creator" }),
    );
    expect(result.alreadyReleased).toBe(false);
  });

  it("treats duplicate confirmation as success without another transfer", async () => {
    const admin = adminWithClaims({
      already_released: true,
      transaction: { ...transaction, payout_status: "released" },
    });

    const result = await releasePendingPayout(admin as never, {
      transactionId: transaction.id,
      mode: "payer_confirmation",
      actorProfileId: "business-1",
    });

    expect(result.alreadyReleased).toBe(true);
    expect(mocks.transferCreate).not.toHaveBeenCalled();
  });

  it("returns the claim to a retryable state when Stripe fails", async () => {
    mocks.transferCreate.mockRejectedValue(new Error("temporary Stripe failure"));
    const admin = adminWithClaims({
      already_released: false,
      should_transfer: true,
      transaction,
    });

    await expect(
      releasePendingPayout(admin as never, {
        transactionId: transaction.id,
        mode: "automatic",
      }),
    ).rejects.toThrow("temporary Stripe failure");
    expect(admin.rpc).toHaveBeenCalledWith(
      "record_campaign_payout_release_failure",
      expect.objectContaining({ error_message: "temporary Stripe failure" }),
    );
  });
});

