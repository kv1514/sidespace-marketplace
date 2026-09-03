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
    mocks.transferCreate.mockResolvedValue({
      id: "tr_creator",
      amount: 9_500,
      currency: "usd",
      destination: "acct_creator",
      source_transaction: "ch_platform",
      transfer_group: "sidespace_campaign_transaction-1",
    });
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

  it.each(["ch_discounted", null])("funds the full creator payout from SideSpace for a promo order (%s)", async (charge) => {
    mocks.transferCreate.mockResolvedValue({ id: "tr_promo", amount: 9500, currency: "usd", destination: "acct_creator", source_transaction: null, transfer_group: "sidespace_campaign_transaction-1" });
    const admin = adminWithClaims({ should_transfer: true, transaction: {
      ...transaction, stripe_charge_id: charge, payout_funding: "platform", charged_total_cents: charge ? 5500 : 0,
      ad_credit_cents: charge ? 5000 : 10500, customer_total_cents: 10500,
      paid_at: "2026-09-03T00:00:00Z", stripe_checkout_session_id: "cs_promo",
    } });
    await releasePendingPayout(admin as never, { transactionId: transaction.id, mode: "automatic" });
    const [params, options] = mocks.transferCreate.mock.calls[0];
    expect(params.amount).toBe(9500);
    expect(params).not.toHaveProperty("source_transaction");
    expect(options.idempotencyKey).toBe("sidespace-payout-transaction-1-platform-0");
    expect(admin.rpc).toHaveBeenCalledWith("finalize_campaign_payout_release", expect.objectContaining({ transfer_id: "tr_promo" }));
  });

  it.each([true, false])("advances a funding attempt only after a definitive Stripe rejection (%s)", async (definitive) => {
    mocks.transferCreate.mockRejectedValue(Object.assign(new Error("Funding unavailable"), definitive ? { type: "StripeInvalidRequestError", code: "balance_insufficient", statusCode: 400 } : { type: "StripeConnectionError" }));
    const admin = adminWithClaims({ should_transfer: true, transaction: { ...transaction, payout_funding: "platform", payout_funding_attempt: 2 } });
    await expect(releasePendingPayout(admin as never, { transactionId: transaction.id, mode: "automatic" })).rejects.toThrow("Funding unavailable");
    expect(mocks.transferCreate.mock.calls[0][1].idempotencyKey).toBe("sidespace-payout-transaction-1-platform-2");
    expect(admin.rpc).toHaveBeenCalledWith(definitive ? "record_platform_payout_funding_failure" : "record_campaign_payout_release_failure", expect.objectContaining({ target_transaction_id: transaction.id }));
    if (!definitive) expect(admin.rpc).not.toHaveBeenCalledWith("record_platform_payout_funding_failure", expect.anything());
  });

  it("does not fund an unverified free order", async () => {
    const admin = adminWithClaims({ should_transfer: true, transaction: { ...transaction, payout_funding: "platform", stripe_charge_id: null, charged_total_cents: 0 } });
    await expect(releasePendingPayout(admin as never, { transactionId: transaction.id, mode: "automatic" })).rejects.toThrow(/verified platform charge/);
    expect(mocks.transferCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["amount", { amount: 9_499 }],
    ["currency", { currency: "eur" }],
    ["destination", { destination: "acct_other_creator" }],
    ["source charge", { source_transaction: "ch_other" }],
    ["transfer group", { transfer_group: "sidespace_campaign_other" }],
  ])("does not finalize a transfer whose Stripe %s drifts from the ledger", async (_field, drift) => {
    mocks.transferCreate.mockResolvedValue({
      id: "tr_wrong",
      amount: 9_500,
      currency: "usd",
      destination: "acct_creator",
      source_transaction: "ch_platform",
      transfer_group: "sidespace_campaign_transaction-1",
      ...drift,
    });
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
    ).rejects.toThrow(/trusted payout ledger/);
    expect(admin.rpc).toHaveBeenCalledWith(
      "record_campaign_payout_release_failure",
      expect.objectContaining({ error_message: expect.stringMatching(/trusted payout ledger/) }),
    );
    expect(admin.rpc).not.toHaveBeenCalledWith(
      "finalize_campaign_payout_release",
      expect.anything(),
    );
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

  it("records an incomplete ledger claim instead of stranding it as releasing", async () => {
    const admin = adminWithClaims({
      already_released: false,
      should_transfer: true,
      transaction: { ...transaction, stripe_charge_id: null },
    });

    await expect(
      releasePendingPayout(admin as never, {
        transactionId: transaction.id,
        mode: "automatic",
      }),
    ).rejects.toThrow(/platform charge is missing/);
    expect(admin.rpc).toHaveBeenCalledWith(
      "record_campaign_payout_release_failure",
      expect.objectContaining({ error_message: expect.stringMatching(/platform charge/) }),
    );
  });
});
