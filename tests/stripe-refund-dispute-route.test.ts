import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  getStripe: vi.fn(),
  getStripeWebhookSecrets: vi.fn(() => ["whsec_test_secret"]),
  stripeKeyMode: vi.fn(() => "test"),
  verifyStripeWebhookEvent: vi.fn(),
  payoutRecoveryTargetCents: vi.fn(() => 9_500),
  recoverReleasedPayout: vi.fn(),
  releasePendingPayout: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/stripe/server", () => ({
  getStripe: mocks.getStripe,
  getStripeWebhookSecrets: mocks.getStripeWebhookSecrets,
  stripeKeyMode: mocks.stripeKeyMode,
}));
vi.mock("@/lib/payments/recovery", () => ({
  payoutRecoveryTargetCents: mocks.payoutRecoveryTargetCents,
  recoverReleasedPayout: mocks.recoverReleasedPayout,
}));
vi.mock("@/lib/payments/release", () => ({
  releasePendingPayout: mocks.releasePendingPayout,
}));
vi.mock("@/lib/stripe/webhook", () => ({
  assertStripeMoneyMatchesLedger: (input: {
    amount: number | null | undefined;
    currency: string | null | undefined;
    expectedAmountCents: number;
    expectedCurrency: string;
  }) => {
    if (
      input.amount !== input.expectedAmountCents ||
      input.currency !== input.expectedCurrency
    ) {
      throw new Error("Charge amount or currency does not match the stored ledger.");
    }
  },
  isStaleCheckoutSession: () => false,
  assertStripeCheckoutAmounts: vi.fn(),
  verifyStripeWebhookEventWithSecrets: mocks.verifyStripeWebhookEvent,
}));

import { POST } from "../app/api/stripe/webhook/route";

const transactionId = "123e4567-e89b-42d3-a456-426614174000";
const campaignRequestId = "223e4567-e89b-42d3-a456-426614174000";

function chain(result: unknown, terminal: "maybeSingle" | "eq") {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["eq", "select", "or", "in", "order", "limit"]) {
    if (method !== terminal) query[method] = vi.fn().mockReturnValue(query);
  }
  query[terminal] = vi.fn().mockResolvedValue(result);
  return query;
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: transactionId,
    campaign_request_id: campaignRequestId,
    currency: "usd",
    customer_total_cents: 10_500,
    tax_cents: 1_050,
    refunded_cents: 0,
    status: "paid",
    workflow_status: "completed",
    payout_status: "released",
    issue_status: "none",
    delivered_at: "2026-08-30T12:00:00.000Z",
    review_deadline: "2026-09-02T12:00:00.000Z",
    stripe_transfer_id: "tr_creator",
    stripe_connected_account_id: "acct_creator",
    creator_payout_cents: 9_500,
    payout_amount_cents: 9_500,
    payout_recovery_status: "not_required",
    payout_recovery_target_cents: 0,
    payout_recovery_reversed_cents: 0,
    dispute_status: null,
    ...overrides,
  };
}

function makeAdmin(currentTransaction: Record<string, unknown>) {
  let transactionUpdate: Record<string, unknown> | null = null;
  const transactionTable = {
    select: vi.fn(() => chain({ data: currentTransaction, error: null }, "maybeSingle")),
    update: vi.fn((payload: Record<string, unknown>) => {
      transactionUpdate = payload;
      return chain({ data: { id: transactionId }, error: null }, "maybeSingle");
    }),
  };
  const refundsTable = {
    upsert: vi.fn().mockResolvedValue({ error: null }),
  };
  const disputesTable = {
    upsert: vi.fn().mockResolvedValue({ error: null }),
  };
  const campaignTable = {
    update: vi.fn(() => ({
      eq: vi.fn(() => ({
        in: vi.fn().mockResolvedValue({ error: null }),
      })),
    })),
  };
  const webhookTable = {
    insert: vi.fn().mockResolvedValue({ error: null }),
    update: vi.fn(() => chain({ error: null }, "eq")),
  };
  const admin = {
    from: vi.fn((table: string) => {
      if (table === "payment_transactions") return transactionTable;
      if (table === "payment_refunds") return refundsTable;
      if (table === "payment_disputes") return disputesTable;
      if (table === "campaign_requests") return campaignTable;
      if (table === "stripe_webhook_events") return webhookTable;
      throw new Error(`Unexpected table ${table}`);
    }),
  };
  return {
    admin,
    transactionTable,
    refundsTable,
    disputesTable,
    campaignTable,
    get transactionUpdate() {
      return transactionUpdate;
    },
  };
}

function webhookRequest() {
  return new Request("http://localhost:3000/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=test" },
    body: "{}",
  });
}

function setEvent(type: string, object: Record<string, unknown>) {
  if (type.startsWith("refund.")) {
    mocks.getStripe().refunds.retrieve.mockResolvedValue(object);
  }
  mocks.verifyStripeWebhookEvent.mockReturnValue({
    id: `evt_${type.replaceAll(".", "_")}`,
    type,
    livemode: false,
    data: { object },
  });
}

describe("Stripe refund and dispute webhook routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStripe.mockReturnValue({
      charges: { retrieve: vi.fn() },
      refunds: { retrieve: vi.fn() },
      disputes: { retrieve: vi.fn() },
    });
    mocks.recoverReleasedPayout.mockResolvedValue({
      alreadyRecovered: false,
      busy: false,
    });
  });

  it.each(["refund.created", "refund.updated"])(
    "reconciles a succeeded %s post-release refund and queues transfer recovery",
    async (eventType) => {
      const stripe = mocks.getStripe();
      stripe.charges.retrieve.mockResolvedValue({
        id: "ch_platform",
        amount: 11_550,
        amount_refunded: 11_550,
        currency: "usd",
        payment_intent: "pi_platform",
        metadata: { sidespace_transaction_id: transactionId },
      });
      const refund = {
        id: "re_succeeded",
        charge: "ch_platform",
        amount: 11_550,
        status: "succeeded",
        reason: "requested_by_customer",
        metadata: {},
      };
      setEvent(eventType, refund);
      const adminState = makeAdmin(transaction());
      mocks.createAdminClient.mockReturnValue(adminState.admin);

      const response = await POST(webhookRequest());

      expect(response.status).toBe(200);
      expect(adminState.refundsTable.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          stripe_refund_id: "re_succeeded",
          transaction_id: transactionId,
          amount_cents: 11_550,
          status: "succeeded",
        }),
      );
      expect(adminState.transactionUpdate).toMatchObject({
        status: "refunded",
        payout_status: "released",
        refunded_cents: 11_550,
      });
      expect(mocks.recoverReleasedPayout).toHaveBeenCalledWith(
        adminState.admin,
        expect.objectContaining({
          transactionId,
          targetReversalCents: 9_500,
          reason: "refund",
        }),
      );
      expect(adminState.campaignTable.update).toHaveBeenCalledWith({
        status: "refunded",
      });
    },
  );

  it("blocks a pre-release payout while a Stripe refund is pending", async () => {
    const stripe = mocks.getStripe();
    stripe.charges.retrieve.mockResolvedValue({
      id: "ch_platform",
      amount: 11_550,
      amount_refunded: 11_550,
      currency: "usd",
      payment_intent: "pi_platform",
      metadata: { sidespace_transaction_id: transactionId },
    });
    setEvent("refund.created", {
      id: "re_pending",
      charge: "ch_platform",
      amount: 11_550,
      status: "pending",
      reason: "requested_by_customer",
      metadata: {},
    });
    const adminState = makeAdmin(
      transaction({
        payout_status: "pending",
        workflow_status: "awaiting_payer_review",
        delivered_at: "2026-08-30T12:00:00.000Z",
      }),
    );
    mocks.createAdminClient.mockReturnValue(adminState.admin);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(adminState.transactionUpdate).toMatchObject({
      status: "refunded",
      workflow_status: "refund_pending",
      payout_status: "blocked",
      refunded_cents: 11_550,
    });
    expect(adminState.campaignTable.update).not.toHaveBeenCalled();
    expect(mocks.recoverReleasedPayout).not.toHaveBeenCalled();
  });

  it("uses Stripe's current refund state instead of a stale webhook snapshot", async () => {
    const stripe = mocks.getStripe();
    stripe.charges.retrieve.mockResolvedValue({
      id: "ch_platform",
      amount: 11_550,
      amount_refunded: 11_550,
      currency: "usd",
      payment_intent: "pi_platform",
      metadata: { sidespace_transaction_id: transactionId },
    });
    setEvent("refund.updated", {
      id: "re_out_of_order",
      charge: "ch_platform",
      amount: 11_550,
      status: "pending",
      reason: "requested_by_customer",
      metadata: {},
    });
    stripe.refunds.retrieve.mockResolvedValue({
      id: "re_out_of_order",
      charge: "ch_platform",
      amount: 11_550,
      status: "succeeded",
      reason: "requested_by_customer",
      metadata: {},
    });
    const adminState = makeAdmin(transaction());
    mocks.createAdminClient.mockReturnValue(adminState.admin);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(stripe.refunds.retrieve).toHaveBeenCalledWith("re_out_of_order");
    expect(adminState.refundsTable.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_refund_id: "re_out_of_order",
        status: "succeeded",
      }),
    );
    expect(adminState.transactionUpdate).toMatchObject({
      status: "refunded",
      workflow_status: "refunded",
    });
    expect(mocks.recoverReleasedPayout).toHaveBeenCalled();
  });

  it("restores a released payout workflow when a pending refund later fails", async () => {
    const stripe = mocks.getStripe();
    stripe.charges.retrieve.mockResolvedValue({
      id: "ch_platform",
      amount: 11_550,
      amount_refunded: 0,
      currency: "usd",
      payment_intent: "pi_platform",
      metadata: { sidespace_transaction_id: transactionId },
    });
    setEvent("refund.failed", {
      id: "re_failed_after_pending",
      charge: "ch_platform",
      amount: 11_550,
      status: "failed",
      reason: "requested_by_customer",
      metadata: {},
    });
    const adminState = makeAdmin(
      transaction({
        status: "refunded",
        workflow_status: "refund_pending",
        refunded_cents: 11_550,
        payout_status: "released",
      }),
    );
    mocks.createAdminClient.mockReturnValue(adminState.admin);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(adminState.transactionUpdate).toMatchObject({
      status: "paid",
      workflow_status: "completed",
      payout_status: "released",
      refunded_cents: 0,
    });
    expect(adminState.campaignTable.update).not.toHaveBeenCalled();
    expect(mocks.recoverReleasedPayout).not.toHaveBeenCalled();
  });

  it.each(["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"])(
    "marks a lost post-release %s and queues dispute recovery",
    async (eventType) => {
      const stripe = mocks.getStripe();
      stripe.charges.retrieve.mockResolvedValue({
        id: "ch_platform",
        amount: 11_550,
        amount_refunded: 0,
        currency: "usd",
        payment_intent: "pi_platform",
        metadata: { sidespace_transaction_id: transactionId },
      });
      stripe.disputes.retrieve.mockResolvedValue({
        id: "dp_lost",
        amount: 11_550,
        status: "lost",
        reason: "fraudulent",
      });
      setEvent(eventType, {
        id: "dp_lost",
        charge: "ch_platform",
        amount: 11_550,
        status: "won",
        reason: "fraudulent",
      });
      const adminState = makeAdmin(transaction());
      mocks.createAdminClient.mockReturnValue(adminState.admin);

      const response = await POST(webhookRequest());

      expect(response.status).toBe(200);
      expect(adminState.disputesTable.upsert).toHaveBeenCalledWith({
        stripe_dispute_id: "dp_lost",
        transaction_id: transactionId,
        amount_cents: 11_550,
        status: "lost",
        reason: "fraudulent",
      });
      expect(adminState.transactionUpdate).toMatchObject({
        status: "disputed",
        dispute_status: "lost",
        payout_status: "released",
        workflow_status: "disputed",
      });
      expect(mocks.recoverReleasedPayout).toHaveBeenCalledWith(
        adminState.admin,
        expect.objectContaining({
          transactionId,
          targetReversalCents: 9_500,
          reason: "dispute",
        }),
      );
      expect(adminState.campaignTable.update).toHaveBeenCalledWith({
        status: "disputed",
      });
    },
  );

  it("records an open dispute without initiating transfer recovery", async () => {
    const stripe = mocks.getStripe();
    stripe.charges.retrieve.mockResolvedValue({
      id: "ch_platform",
      amount: 11_550,
      amount_refunded: 0,
      currency: "usd",
      payment_intent: "pi_platform",
      metadata: { sidespace_transaction_id: transactionId },
    });
    stripe.disputes.retrieve.mockResolvedValue({
      id: "dp_open",
      amount: 11_550,
      status: "needs_response",
      reason: "fraudulent",
    });
    setEvent("charge.dispute.created", {
      id: "dp_open",
      charge: "ch_platform",
      amount: 11_550,
      status: "needs_response",
      reason: "fraudulent",
    });
    const adminState = makeAdmin(transaction());
    mocks.createAdminClient.mockReturnValue(adminState.admin);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(adminState.disputesTable.upsert).toHaveBeenCalledWith({
      stripe_dispute_id: "dp_open",
      transaction_id: transactionId,
      amount_cents: 11_550,
      status: "needs_response",
      reason: "fraudulent",
    });
    expect(adminState.transactionUpdate).toMatchObject({
      status: "disputed",
      dispute_status: "needs_response",
      payout_status: "released",
      workflow_status: "disputed",
    });
    expect(mocks.recoverReleasedPayout).not.toHaveBeenCalled();
  });

  it("keeps a partial-refund payout blocked when a dispute is won", async () => {
    const stripe = mocks.getStripe();
    stripe.charges.retrieve.mockResolvedValue({
      id: "ch_platform",
      amount: 11_550,
      amount_refunded: 2_000,
      currency: "usd",
      payment_intent: "pi_platform",
      metadata: { sidespace_transaction_id: transactionId },
    });
    stripe.disputes.retrieve.mockResolvedValue({
      id: "dp_won_partial_refund",
      amount: 11_550,
      status: "won",
      reason: "fraudulent",
    });
    setEvent("charge.dispute.closed", {
      id: "dp_won_partial_refund",
      charge: "ch_platform",
      amount: 11_550,
      status: "won",
      reason: "fraudulent",
    });
    const adminState = makeAdmin(
      transaction({
        status: "partially_refunded",
        workflow_status: "partially_refunded",
        payout_status: "blocked",
        refunded_cents: 2_000,
        payout_amount_cents: 9_500,
        dispute_status: "needs_response",
      }),
    );
    mocks.createAdminClient.mockReturnValue(adminState.admin);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(adminState.transactionUpdate).toMatchObject({
      status: "partially_refunded",
      dispute_status: "won",
      payout_status: "blocked",
      workflow_status: "partially_refunded",
      refunded_cents: 2_000,
      payout_amount_cents: 7_854,
    });
    expect(mocks.recoverReleasedPayout).not.toHaveBeenCalled();
  });

  it("keeps a completed campaign completed when a released dispute is won", async () => {
    const stripe = mocks.getStripe();
    stripe.charges.retrieve.mockResolvedValue({
      id: "ch_platform",
      amount: 11_550,
      amount_refunded: 0,
      currency: "usd",
      payment_intent: "pi_platform",
      metadata: { sidespace_transaction_id: transactionId },
    });
    stripe.disputes.retrieve.mockResolvedValue({
      id: "dp_won",
      amount: 11_550,
      status: "won",
      reason: "fraudulent",
    });
    setEvent("charge.dispute.closed", {
      id: "dp_won",
      charge: "ch_platform",
      amount: 11_550,
      status: "won",
      reason: "fraudulent",
    });
    const adminState = makeAdmin(transaction());
    mocks.createAdminClient.mockReturnValue(adminState.admin);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(adminState.transactionUpdate).toMatchObject({
      status: "paid",
      dispute_status: "won",
      payout_status: "released",
      workflow_status: "completed",
    });
    expect(adminState.campaignTable.update).toHaveBeenCalledWith({
      status: "completed",
    });
    expect(mocks.recoverReleasedPayout).not.toHaveBeenCalled();
  });

  it("restores a pre-release payout after a failed refund has no refunded amount", async () => {
    const stripe = mocks.getStripe();
    stripe.charges.retrieve.mockResolvedValue({
      id: "ch_platform",
      amount: 11_550,
      amount_refunded: 0,
      currency: "usd",
      payment_intent: "pi_platform",
      metadata: { sidespace_transaction_id: transactionId },
    });
    setEvent("refund.failed", {
      id: "re_failed",
      charge: "ch_platform",
      amount: 11_550,
      status: "failed",
      reason: "requested_by_customer",
      metadata: {},
    });
    const adminState = makeAdmin(
      transaction({
        workflow_status: "refunded",
        payout_status: "refunded",
        stripe_transfer_id: null,
        delivered_at: null,
        review_deadline: null,
      }),
    );
    mocks.createAdminClient.mockReturnValue(adminState.admin);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(adminState.transactionUpdate).toMatchObject({
      status: "paid",
      payout_status: "pending",
      workflow_status: "paid_payout_pending",
      refunded_cents: 0,
    });
    expect(mocks.recoverReleasedPayout).not.toHaveBeenCalled();
  });

  it("restores a reduced payout after a failed partial refund", async () => {
    const stripe = mocks.getStripe();
    stripe.charges.retrieve.mockResolvedValue({
      id: "ch_platform",
      amount: 10_500,
      amount_refunded: 0,
      currency: "usd",
      payment_intent: "pi_platform",
      metadata: { sidespace_transaction_id: transactionId },
    });
    setEvent("refund.failed", {
      id: "re_partial_failed",
      charge: "ch_platform",
      amount: 1_000,
      status: "failed",
      reason: "requested_by_customer",
      metadata: {},
    });
    const adminState = makeAdmin(
      transaction({
        customer_total_cents: 10_500,
        tax_cents: 0,
        refunded_cents: 0,
        payout_amount_cents: 8_595,
        workflow_status: "refund_pending",
        payout_status: "blocked",
        issue_status: "resolution_pending",
        stripe_transfer_id: null,
        delivered_at: null,
        review_deadline: null,
      }),
    );
    mocks.createAdminClient.mockReturnValue(adminState.admin);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(adminState.transactionUpdate).toMatchObject({
      status: "paid",
      payout_status: "blocked",
      workflow_status: "refund_pending",
      payout_amount_cents: 9_500,
      refunded_cents: 0,
    });
  });
});
