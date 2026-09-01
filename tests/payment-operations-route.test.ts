import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  getStripe: vi.fn(),
  releasePendingPayout: vi.fn(),
  recoverReleasedPayout: vi.fn(),
  transferRetrieve: vi.fn(),
  balanceRetrieve: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/stripe/server", () => ({
  getStripe: mocks.getStripe,
}));
vi.mock("@/lib/payments/release", () => ({
  releasePendingPayout: mocks.releasePendingPayout,
}));
vi.mock("@/lib/payments/recovery", () => ({
  recoverReleasedPayout: mocks.recoverReleasedPayout,
}));

import { GET as cronGET } from "../app/api/cron/release-payouts/route";
import { GET as healthGET } from "../app/api/health/payments/route";

type CountResult = {
  count: number | null;
  error: { message?: string } | null;
};

function listQuery(result: unknown) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "in", "lte", "gte", "neq", "not", "or", "order"]) {
    query[method] = vi.fn().mockReturnValue(query);
  }
  query.limit = vi.fn().mockResolvedValue(result);
  return query;
}

function countQuery(result: CountResult) {
  type CountQuery = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<CountResult>;
  const query = {} as CountQuery;
  for (const method of ["select", "eq", "in", "lte", "gte", "neq", "not", "or", "order"]) {
    query[method] = vi.fn().mockReturnValue(query);
  }
  query.then = (onFulfilled, onRejected) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return query;
}

function makeCronAdmin(input: {
  due?: unknown[];
  stuck?: unknown[];
  partialRefund?: unknown[];
  recovery?: unknown[];
  staleRecovery?: unknown[];
  released?: unknown[];
} = {}) {
  const transactionQueries = [
    listQuery({ data: input.due ?? [], error: null }),
    listQuery({ data: input.stuck ?? [], error: null }),
    listQuery({ data: input.partialRefund ?? [], error: null }),
    listQuery({ data: input.released ?? [], error: null }),
  ];
  const reversalQueries = [
    listQuery({ data: input.recovery ?? [], error: null }),
    listQuery({ data: input.staleRecovery ?? [], error: null }),
  ];
  const admin = {
    from: vi.fn((table: string) => {
      if (table === "payment_transactions") {
        return transactionQueries.shift() ?? listQuery({ data: [], error: null });
      }
      if (table === "payment_transfer_reversals") {
        return reversalQueries.shift() ?? listQuery({ data: [], error: null });
      }
      throw new Error(`Unexpected table ${table}`);
    }),
  };
  return { admin };
}

function makeHealthAdmin(counts: number[], errorAt = -1) {
  let index = 0;
  const queries: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
  const admin = {
    from: vi.fn(() => {
      const currentIndex = index++;
      const query = countQuery({
        count: counts[currentIndex] ?? 0,
        error:
          currentIndex === errorAt
            ? { message: "payment health query failed" }
            : null,
      });
      queries.push(query);
      return query;
    }),
  };
  return { admin, queries };
}

function cronRequest(authorization = "Bearer cron-secret") {
  return new Request("http://localhost:3000/api/cron/release-payouts", {
    headers: { authorization },
  });
}

function healthRequest(authorization = "Bearer monitoring-secret") {
  return new Request("http://localhost:3000/api/health/payments", {
    headers: { authorization },
  });
}

const transfer = {
  id: "tr_creator",
  amount: 9_500,
  amount_reversed: 0,
  currency: "usd",
  destination: "acct_creator",
  source_transaction: "ch_platform",
  transfer_group: "sidespace_campaign_tx-released",
};

describe("payment operations routes", () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const originalMonitoringSecret = process.env.PAYMENTS_MONITORING_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "cron-secret";
    process.env.PAYMENTS_MONITORING_SECRET = "monitoring-secret";
    mocks.releasePendingPayout.mockResolvedValue({
      alreadyReleased: false,
      transaction: { payout_status: "released" },
    });
    mocks.recoverReleasedPayout.mockResolvedValue({
      alreadyRecovered: false,
      busy: false,
    });
    mocks.transferRetrieve.mockResolvedValue(transfer);
    mocks.balanceRetrieve.mockResolvedValue({});
    mocks.getStripe.mockReturnValue({
      transfers: { retrieve: mocks.transferRetrieve },
      balance: { retrieve: mocks.balanceRetrieve },
    });
  });

  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
    if (originalMonitoringSecret === undefined) {
      delete process.env.PAYMENTS_MONITORING_SECRET;
    } else {
      process.env.PAYMENTS_MONITORING_SECRET = originalMonitoringSecret;
    }
  });

  it("requires the cron secret before reading or releasing payouts", async () => {
    const response = await cronGET(cronRequest("Bearer wrong-secret"));

    expect(response.status).toBe(401);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("deduplicates due, stale, partial-refund, and recovery work and reconciles released transfers", async () => {
    const state = makeCronAdmin({
      due: [{ id: "tx-due" }],
      stuck: [{ id: "tx-stuck" }],
      partialRefund: [{ id: "tx-partial" }],
      recovery: [
        { transaction_id: "tx-recovery", target_amount_cents: 905, reason: "refund" },
      ],
      staleRecovery: [
        { transaction_id: "tx-recovery", target_amount_cents: 905, reason: "refund" },
      ],
      released: [
        {
          id: "tx-released",
          stripe_transfer_id: "tr_creator",
          stripe_connected_account_id: "acct_creator",
          stripe_charge_id: "ch_platform",
          payout_amount_cents: 9_500,
          payout_recovery_reversed_cents: 0,
          currency: "usd",
        },
      ],
    });
    mocks.createAdminClient.mockReturnValue(state.admin);

    const response = await cronGET(cronRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      checked: 3,
      released: 3,
      recoveryChecked: 1,
      recovered: 1,
      transfersReconciled: 1,
      failed: [],
    });
    expect(mocks.releasePendingPayout).toHaveBeenCalledTimes(3);
    expect(mocks.releasePendingPayout).toHaveBeenNthCalledWith(
      1,
      state.admin,
      { transactionId: "tx-due", mode: "automatic" },
    );
    expect(mocks.releasePendingPayout).toHaveBeenNthCalledWith(
      3,
      state.admin,
      { transactionId: "tx-partial", mode: "partial_refund_resolution" },
    );
    expect(mocks.recoverReleasedPayout).toHaveBeenCalledOnce();
    expect(mocks.transferRetrieve).toHaveBeenCalledWith("tr_creator");
  });

  it("returns 500 with every release, recovery, and reconciliation failure", async () => {
    const state = makeCronAdmin({
      due: [{ id: "tx-due" }],
      recovery: [
        { transaction_id: "tx-recovery", target_amount_cents: 905, reason: "dispute" },
      ],
      released: [
        {
          id: "tx-released",
          stripe_transfer_id: "tr_creator",
          stripe_connected_account_id: "acct_creator",
          stripe_charge_id: "ch_platform",
          payout_amount_cents: 9_500,
          payout_recovery_reversed_cents: 0,
          currency: "usd",
        },
      ],
    });
    mocks.createAdminClient.mockReturnValue(state.admin);
    mocks.releasePendingPayout.mockRejectedValue(new Error("release failed"));
    mocks.recoverReleasedPayout.mockRejectedValue(new Error("recovery failed"));
    mocks.transferRetrieve.mockResolvedValue({ ...transfer, amount: 9_499 });

    const response = await cronGET(cronRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.failed).toEqual(
      expect.arrayContaining([
        { transactionId: "tx-due", error: "release failed" },
        { transactionId: "tx-recovery", error: "recovery failed" },
        {
          transactionId: "tx-released",
          error: "tx-released: Stripe transfer does not match the SideSpace ledger",
        },
      ]),
    );
  });

  it("requires the monitoring secret before running health checks", async () => {
    const response = await healthGET(healthRequest("Bearer wrong-secret"));

    expect(response.status).toBe(401);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("reports ready only when all operational counts are clear and Stripe is reachable", async () => {
    const state = makeHealthAdmin([0, 0, 0, 0, 0, 0, 0, 0]);
    mocks.createAdminClient.mockReturnValue(state.admin);

    const response = await healthGET(healthRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "ready",
      checks: {
        stripeApi: "reachable",
        failedWebhooksLastHour: 0,
        staleWebhookClaims: 0,
        stuckPayoutReleases: 0,
        overduePayouts: 0,
        activeDisputes: 0,
        postPayoutRecoveries: 0,
        pendingRefundResolutions: 0,
        stuckPartialRefundPayouts: 0,
        unexpectedPartialRefunds: 0,
      },
    });
    expect(state.queries[4]?.or).toHaveBeenCalledWith(
      "dispute_status.is.null,dispute_status.not.in.(won,lost)",
    );
    expect(mocks.balanceRetrieve).toHaveBeenCalledOnce();
  });

  it("returns attention_required when any monitored payment condition is nonzero", async () => {
    const state = makeHealthAdmin([1, 0, 0, 0, 1, 0, 0, 0]);
    mocks.createAdminClient.mockReturnValue(state.admin);

    const response = await healthGET(healthRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("attention_required");
    expect(body.checks).toMatchObject({
      failedWebhooksLastHour: 1,
      activeDisputes: 1,
    });
  });

  it("alerts on an old blocked partial refund that bypassed staff resolution", async () => {
    const state = makeHealthAdmin([0, 0, 0, 0, 0, 0, 0, 0, 1]);
    mocks.createAdminClient.mockReturnValue(state.admin);

    const response = await healthGET(healthRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "attention_required",
      checks: { unexpectedPartialRefunds: 1 },
    });
    expect(state.queries[8]?.or).toHaveBeenCalledWith(
      "payout_release_reason.is.null,payout_release_reason.neq.partial_refund_resolution",
    );
  });

  it("sanitizes database and Stripe health failures", async () => {
    const state = makeHealthAdmin([0, 0, 0, 0, 0, 0, 0, 0], 0);
    mocks.createAdminClient.mockReturnValue(state.admin);

    const databaseResponse = await healthGET(healthRequest());
    expect(databaseResponse.status).toBe(503);
    expect(await databaseResponse.json()).toEqual({
      status: "unavailable",
      error: "Payment health checks could not complete.",
    });

    const healthyState = makeHealthAdmin([0, 0, 0, 0, 0, 0, 0, 0]);
    mocks.createAdminClient.mockReturnValue(healthyState.admin);
    mocks.balanceRetrieve.mockRejectedValue(new Error("Stripe unavailable"));

    const stripeResponse = await healthGET(healthRequest());
    expect(stripeResponse.status).toBe(503);
    expect(await stripeResponse.json()).toEqual({
      status: "unavailable",
      error: "Payment health checks could not complete.",
    });
  });
});
