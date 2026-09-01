import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  getStripe: vi.fn(),
  getStripeWebhookSecrets: vi.fn(() => ["whsec_test_secret"]),
  stripeKeyMode: vi.fn(() => "test"),
  verifyStripeWebhookEvent: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/stripe/server", () => ({
  getStripe: mocks.getStripe,
  getStripeWebhookSecrets: mocks.getStripeWebhookSecrets,
  stripeKeyMode: mocks.stripeKeyMode,
}));
vi.mock("@/lib/stripe/webhook", () => ({
  assertStripeCheckoutAmounts: (
    input: {
      amountSubtotal: number | null;
      amountTotal: number | null;
      customerTotalCents: number;
      taxCents: number;
      paymentStatus: string | null;
    },
  ) => {
    if (input.amountSubtotal !== input.customerTotalCents) {
      throw new Error("Checkout Session amount does not match the stored ledger.");
    }
    if (
      (input.paymentStatus === "paid" ||
        input.paymentStatus === "no_payment_required") &&
      input.amountTotal !== input.customerTotalCents + input.taxCents
    ) {
      throw new Error("Checkout Session total does not match the stored ledger.");
    }
  },
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
  isStaleCheckoutSession: (
    storedSessionId: string | null,
    receivedSessionId: string,
  ) => Boolean(storedSessionId && storedSessionId !== receivedSessionId),
  verifyStripeWebhookEventWithSecrets: mocks.verifyStripeWebhookEvent,
}));

import { POST } from "../app/api/stripe/webhook/route";

const transactionId = "123e4567-e89b-42d3-a456-426614174000";
const campaignRequestId = "223e4567-e89b-42d3-a456-426614174000";

function chain(result: unknown, terminal: "single" | "maybeSingle" | "eq" | "in") {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["eq", "or", "in", "select", "order", "limit"]) {
    if (method !== terminal) query[method] = vi.fn().mockReturnValue(query);
  }
  query[terminal] = vi.fn().mockResolvedValue(result);
  return query;
}

function eventFor(type: string) {
  return {
    id: `evt_${type.replaceAll(".", "_")}`,
    type,
    livemode: false,
    data: { object: { id: "cs_test_123" } },
  };
}

function checkoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_123",
    livemode: false,
    status: "complete",
    payment_status: "paid",
    metadata: { sidespace_transaction_id: transactionId },
    amount_subtotal: 10_500,
    amount_total: 11_550,
    total_details: { amount_tax: 1_050 },
    customer: "cus_test_123",
    invoice: "in_test_123",
    payment_intent: {
      id: "pi_test_123",
      amount: 11_550,
      currency: "usd",
      transfer_group: `sidespace_campaign_${transactionId}`,
      latest_charge: {
        id: "ch_test_123",
        amount: 11_550,
        currency: "usd",
        transfer: null,
        application_fee: null,
      },
    },
    ...overrides,
  };
}

function storedTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: transactionId,
    campaign_request_id: campaignRequestId,
    currency: "usd",
    customer_total_cents: 10_500,
    tax_cents: 0,
    status: "requires_checkout",
    dispute_status: null,
    stripe_checkout_session_id: "cs_test_123",
    stripe_connected_account_id: "acct_creator",
    stripe_transfer_id: null,
    payout_status: "not_ready",
    workflow_status: "checkout_open",
    issue_status: "none",
    paid_at: null,
    ...overrides,
  };
}

function makeAdmin(input: {
  transaction?: Record<string, unknown>;
  eventInsert?: unknown;
  priorEvent?: unknown;
} = {}) {
  let transactionUpdate: Record<string, unknown> | null = null;
  let fulfillmentInsert: Record<string, unknown> | null = null;
  const transaction = input.transaction ?? storedTransaction();
  const transactionTable = {
    select: vi.fn(() => chain({ data: transaction, error: null }, "single")),
    update: vi.fn((payload: Record<string, unknown>) => {
      transactionUpdate = payload;
      return chain(
        { data: { campaign_request_id: campaignRequestId }, error: null },
        "single",
      );
    }),
  };
  const webhookTable = {
    insert: vi.fn().mockResolvedValue(input.eventInsert ?? { error: null }),
    select: vi.fn(() => chain({ data: input.priorEvent ?? null, error: null }, "maybeSingle")),
    update: vi.fn(() => chain({ error: null }, "eq")),
  };
  const fulfillmentTable = {
    insert: vi.fn((payload: Record<string, unknown>) => {
      fulfillmentInsert = payload;
      return Promise.resolve({ error: null });
    }),
  };
  const campaignTable = {
    update: vi.fn(() => chain({ error: null }, "in")),
  };
  const admin = {
    from: vi.fn((table: string) => {
      if (table === "stripe_webhook_events") return webhookTable;
      if (table === "payment_transactions") return transactionTable;
      if (table === "payment_fulfillment_events") return fulfillmentTable;
      if (table === "campaign_requests") return campaignTable;
      throw new Error(`Unexpected table ${table}`);
    }),
  };
  return {
    admin,
    transactionTable,
    webhookTable,
    campaignTable,
    get transactionUpdate() {
      return transactionUpdate;
    },
    get fulfillmentInsert() {
      return fulfillmentInsert;
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

describe("Stripe webhook route lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStripe.mockReturnValue({
      checkout: { sessions: { retrieve: vi.fn() } },
      webhooks: { constructEvent: vi.fn() },
    });
  });

  it("verifies a paid Checkout session and leaves the Creator payout pending", async () => {
    const session = checkoutSession();
    const stripe = mocks.getStripe();
    stripe.checkout.sessions.retrieve.mockResolvedValue(session);
    mocks.verifyStripeWebhookEvent.mockReturnValue(
      eventFor("checkout.session.completed"),
    );
    const adminState = makeAdmin({
      transaction: storedTransaction({ tax_cents: 1_050 }),
    });
    mocks.createAdminClient.mockReturnValue(adminState.admin);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith(
      "cs_test_123",
      { expand: ["payment_intent.latest_charge"] },
    );
    expect(adminState.transactionUpdate).toMatchObject({
      status: "paid",
      tax_cents: 1_050,
      refunded_cents: 0,
      stripe_payment_intent_id: "pi_test_123",
      stripe_charge_id: "ch_test_123",
      payout_status: "pending",
      workflow_status: "paid_payout_pending",
    });
    expect(adminState.fulfillmentInsert).toMatchObject({
      transaction_id: transactionId,
      event_type: "payment_verified",
      to_state: "paid_payout_pending",
    });
    expect(adminState.campaignTable.update).toHaveBeenCalledWith({
      status: "confirmed",
    });
  });

  it("turns a successful retry after an async payment failure into a payout-ready payment", async () => {
    const stripe = mocks.getStripe();
    stripe.checkout.sessions.retrieve.mockResolvedValue(checkoutSession());
    mocks.verifyStripeWebhookEvent.mockReturnValue(
      eventFor("checkout.session.async_payment_succeeded"),
    );
    const adminState = makeAdmin({
      transaction: storedTransaction({
        status: "payment_failed",
        workflow_status: "payment_failed",
        payout_status: "not_ready",
      }),
    });
    mocks.createAdminClient.mockReturnValue(adminState.admin);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(adminState.transactionUpdate).toMatchObject({
      status: "paid",
      payout_status: "pending",
      workflow_status: "paid_payout_pending",
    });
    expect(adminState.fulfillmentInsert).toMatchObject({
      event_type: "payment_verified",
      to_state: "paid_payout_pending",
    });
  });

  it.each([
    ["checkout.session.expired", "expired"],
    ["checkout.session.async_payment_failed", "payment_failed"],
  ])("records the terminal %s workflow state", async (eventType, expectedStatus) => {
    const stripe = mocks.getStripe();
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      checkoutSession({
        status: eventType === "checkout.session.expired" ? "expired" : "open",
        payment_status: "unpaid",
        amount_total: null,
        total_details: { amount_tax: 0 },
        payment_intent: null,
        customer: null,
        invoice: null,
      }),
    );
    mocks.verifyStripeWebhookEvent.mockReturnValue(eventFor(eventType));
    const adminState = makeAdmin();
    mocks.createAdminClient.mockReturnValue(adminState.admin);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(adminState.transactionUpdate).toMatchObject({
      status: expectedStatus,
      workflow_status: expectedStatus,
      payout_status: "not_ready",
    });
    expect(adminState.fulfillmentInsert).toBeNull();
    expect(adminState.campaignTable.update).not.toHaveBeenCalled();
  });

  it("acknowledges a processed duplicate event without reprocessing it", async () => {
    mocks.verifyStripeWebhookEvent.mockReturnValue(
      eventFor("checkout.session.completed"),
    );
    const adminState = makeAdmin({
      eventInsert: { error: { code: "23505" } },
      priorEvent: {
        status: "processed",
        attempts: 1,
        received_at: new Date().toISOString(),
      },
    });
    mocks.createAdminClient.mockReturnValue(adminState.admin);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, duplicate: true });
    expect(adminState.transactionTable.update).not.toHaveBeenCalled();
    expect(mocks.getStripe().checkout.sessions.retrieve).not.toHaveBeenCalled();
  });
});
