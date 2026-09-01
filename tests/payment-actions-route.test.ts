import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthenticatedProfile: vi.fn(),
  requireAuthorizedPaymentsStaff: vi.fn(),
  enforcePaymentRateLimit: vi.fn(),
  releasePendingPayout: vi.fn(),
  refundsCreate: vi.fn(),
}));

vi.mock("@/lib/payments/auth", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public readonly status = 400,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    requireSameOrigin: vi.fn(),
    requireUuid: (value: unknown) => String(value),
    requireAuthenticatedProfile: mocks.requireAuthenticatedProfile,
    requireAuthorizedPaymentsStaff: mocks.requireAuthorizedPaymentsStaff,
    errorResponse(error: unknown) {
      if (error instanceof ApiError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      return Response.json(
        { error: "SideSpace could not complete that payment action." },
        { status: 500 },
      );
    },
  };
});
vi.mock("@/lib/payments/rate-limit", () => ({
  enforcePaymentRateLimit: mocks.enforcePaymentRateLimit,
}));
vi.mock("@/lib/payments/release", () => ({
  releasePendingPayout: mocks.releasePendingPayout,
}));
vi.mock("@/lib/stripe/server", () => ({
  getStripe: () => ({ refunds: { create: mocks.refundsCreate } }),
}));

import { POST as actionsPOST } from "../app/api/payments/transactions/[transactionId]/actions/route";
import { POST as resolvePOST } from "../app/api/payments/issues/[issueId]/resolve/route";

const transactionId = "123e4567-e89b-42d3-a456-426614174000";
const issueId = "223e4567-e89b-42d3-a456-426614174000";
const transaction = {
  id: transactionId,
  status: "paid",
  workflow_status: "awaiting_payer_review",
  payout_status: "pending",
  delivered_at: null,
  review_deadline: "2026-09-02T12:00:00.000Z",
  confirmed_at: null,
  issue_status: "none",
  payout_released_at: null,
};

function request(path: string, body: Record<string, unknown>) {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function transactionContext() {
  return { params: Promise.resolve({ transactionId }) };
}

function issueContext() {
  return { params: Promise.resolve({ issueId }) };
}

function query(result: unknown) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "or"]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(result);
  return chain;
}

function authenticatedAdmin(rpcResult: unknown) {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  const admin = { rpc };
  mocks.requireAuthenticatedProfile.mockResolvedValue({
    user: { id: "auth-user" },
    profile: { id: "payer-profile" },
    admin,
  });
  return { admin, rpc };
}

function staffAdmin(input: {
  claimResult?: unknown;
  updatedResolution?: unknown;
  issue?: unknown;
  updateResult?: unknown;
} = {}) {
  const rpc = vi.fn().mockResolvedValue(
    input.claimResult ?? { data: null, error: null },
  );
  const issueTable = query({
    data: input.issue ?? { id: issueId, transaction_id: transactionId, status: "escalated" },
    error: null,
  });
  const resolutionTable = {
    update: vi.fn(() => {
      const chain = query(
        input.updateResult ?? {
          data: input.updatedResolution ?? { id: "resolution-1", status: "completed" },
          error: null,
        },
      );
      return chain;
    }),
  };
  const admin = {
    rpc,
    from: vi.fn((table: string) => {
      if (table === "payment_issues") return issueTable;
      if (table === "payment_resolution_actions") return resolutionTable;
      throw new Error(`Unexpected table ${table}`);
    }),
  };
  mocks.requireAuthorizedPaymentsStaff.mockResolvedValue({
    user: { id: "staff-auth-user" },
    profile: { id: "staff-profile" },
    admin,
  });
  return { admin, rpc, issueTable, resolutionTable };
}

describe("participant payment action routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enforcePaymentRateLimit.mockResolvedValue(undefined);
    mocks.refundsCreate.mockResolvedValue({ id: "re_created" });
  });

  it("rejects an invalid action before touching the authenticated payment state", async () => {
    const response = await actionsPOST(
      request(`/api/payments/transactions/${transactionId}/actions`, {
        action: "refund",
      }),
      transactionContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Choose a valid campaign action." });
    expect(mocks.requireAuthenticatedProfile).not.toHaveBeenCalled();
  });

  it.each([
    [
      "deliver",
      { action: "deliver" },
      "mark_campaign_delivered",
      { target_transaction_id: transactionId, actor_profile_id: "payer-profile" },
      { transaction: transaction },
    ],
    [
      "report_issue",
      { action: "report_issue", details: "The final campaign asset is missing." },
      "report_campaign_issue",
      {
        target_transaction_id: transactionId,
        actor_profile_id: "payer-profile",
        issue_details: "The final campaign asset is missing.",
      },
      { issue: { id: "issue-1", status: "open" } },
    ],
    [
      "escalate",
      { action: "escalate" },
      "escalate_campaign_issue",
      { target_transaction_id: transactionId, actor_profile_id: "payer-profile" },
      { issue: { id: "issue-1", status: "escalated" } },
    ],
  ])("forwards the %s actor and payload to its protected RPC", async (_name, body, rpcName, rpcArgs, result) => {
    const { rpc } = authenticatedAdmin({ data: result, error: null });

    const response = await actionsPOST(
      request(`/api/payments/transactions/${transactionId}/actions`, body),
      transactionContext(),
    );

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(rpcName, rpcArgs);
    expect(mocks.enforcePaymentRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        bucket: "payment_fulfillment_action",
        profileId: "payer-profile",
      }),
    );
  });

  it("confirms completion through the idempotent payout release path", async () => {
    const { admin } = authenticatedAdmin({ data: null, error: null });
    mocks.releasePendingPayout.mockResolvedValue({
      alreadyReleased: false,
      transaction: { ...transaction, payout_status: "released" },
    });

    const response = await actionsPOST(
      request(`/api/payments/transactions/${transactionId}/actions`, {
        action: "confirm",
      }),
      transactionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      alreadyReleased: false,
      transaction: { ...transaction, payout_status: "released" },
    });
    expect(mocks.releasePendingPayout).toHaveBeenCalledWith(admin, {
      transactionId,
      mode: "payer_confirmation",
      actorProfileId: "payer-profile",
    });
  });
});

describe("staff payment resolution routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enforcePaymentRateLimit.mockResolvedValue(undefined);
    mocks.refundsCreate.mockResolvedValue({ id: "re_created" });
  });

  it("releases an escalated payout with staff identity and returns a participant-safe transaction", async () => {
    const state = staffAdmin();
    mocks.releasePendingPayout.mockResolvedValue({
      alreadyReleased: false,
      transaction: { ...transaction, payout_status: "released" },
    });

    const response = await resolvePOST(
      request(`/api/payments/issues/${issueId}/resolve`, { action: "release_payout" }),
      issueContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      alreadyReleased: false,
      transaction: { ...transaction, payout_status: "released" },
    });
    expect(mocks.releasePendingPayout).toHaveBeenCalledWith(state.admin, {
      transactionId,
      mode: "staff",
      staffAuthUserId: "staff-auth-user",
    });
  });

  it("creates a staff partial refund with the claimed idempotency key", async () => {
    const state = staffAdmin({
      claimResult: {
        data: {
          resolution: {
            id: "resolution-1",
            refund_amount_cents: 1_000,
            idempotency_key: "sidespace-refund-resolution-1",
            stripe_refund_id: null,
            status: "processing",
          },
          transaction: { stripe_charge_id: "ch_platform" },
        },
        error: null,
      },
      updatedResolution: {
        id: "resolution-1",
        status: "completed",
        stripe_refund_id: "re_created",
        refund_amount_cents: 1_000,
      },
    });

    const response = await resolvePOST(
      request(`/api/payments/issues/${issueId}/resolve`, {
        action: "partial_refund",
        refundAmountCents: 1_000,
        notes: "Partial delivery accepted.",
      }),
      issueContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resolution: {
        id: "resolution-1",
        status: "completed",
        stripe_refund_id: "re_created",
        refund_amount_cents: 1_000,
      },
    });
    expect(state.rpc).toHaveBeenCalledWith("claim_issue_refund_resolution", {
      target_issue_id: issueId,
      staff_user_id: "staff-auth-user",
      requested_action: "partial_refund",
      requested_refund_cents: 1_000,
      notes: "Partial delivery accepted.",
    });
    expect(mocks.refundsCreate).toHaveBeenCalledWith(
      {
        charge: "ch_platform",
        amount: 1_000,
        reason: "requested_by_customer",
        metadata: {
          sidespace_transaction_id: transactionId,
          sidespace_issue_id: issueId,
          sidespace_resolution_id: "resolution-1",
        },
      },
      { idempotencyKey: "sidespace-refund-resolution-1" },
    );
  });

  it("returns a duplicate resolution without creating a second Stripe refund", async () => {
    staffAdmin({
      claimResult: {
        data: {
          resolution: {
            id: "resolution-1",
            refund_amount_cents: 10_500,
            idempotency_key: "sidespace-refund-resolution-1",
            stripe_refund_id: "re_existing",
            status: "completed",
          },
          transaction: { stripe_charge_id: "ch_platform" },
        },
        error: null,
      },
    });

    const response = await resolvePOST(
      request(`/api/payments/issues/${issueId}/resolve`, { action: "full_refund" }),
      issueContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      duplicate: true,
      resolution: { stripe_refund_id: "re_existing" },
    });
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
  });

  it("records provider failure and returns a generic error instead of leaking Stripe text", async () => {
    const state = staffAdmin({
      claimResult: {
        data: {
          resolution: {
            id: "resolution-1",
            refund_amount_cents: 1_000,
            idempotency_key: "sidespace-refund-resolution-1",
            stripe_refund_id: null,
            status: "processing",
          },
          transaction: { stripe_charge_id: "ch_platform" },
        },
        error: null,
      },
    });
    mocks.refundsCreate.mockRejectedValue(new Error("Stripe secret provider detail"));

    const response = await resolvePOST(
      request(`/api/payments/issues/${issueId}/resolve`, {
        action: "partial_refund",
        refundAmountCents: 1_000,
      }),
      issueContext(),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "SideSpace could not complete that payment action.",
    });
    expect(state.resolutionTable.update).toHaveBeenCalled();
  });
});
