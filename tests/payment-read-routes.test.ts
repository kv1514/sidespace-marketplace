import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthenticatedProfile: vi.fn(),
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
    errorResponse(error: unknown) {
      const failure = error as Error & { status?: number };
      return Response.json(
        { error: failure.message },
        { status: failure.status ?? 500 },
      );
    },
    requireAuthenticatedProfile: mocks.requireAuthenticatedProfile,
    requireSameOrigin: vi.fn(),
    requireUuid: (value: unknown) => String(value),
  };
});

import { POST as reviewPOST } from "../app/api/payments/transactions/[transactionId]/review/route";
import { GET as transactionsGET } from "../app/api/stripe/transactions/route";

const transactionId = "123e4567-e89b-42d3-a456-426614174000";

function reviewRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost:3000/api/payments/transactions/${transactionId}/review`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function reviewContext() {
  return { params: Promise.resolve({ transactionId }) };
}

function transactionQuery(result: unknown) {
  const query = {
    select: vi.fn(),
    or: vi.fn(),
    order: vi.fn().mockResolvedValue(result),
  };
  query.select.mockReturnValue(query);
  query.or.mockReturnValue(query);
  return query;
}

describe("participant payment read routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires authentication before reading the transaction feed", async () => {
    const unauthorized = new Error("Sign in to continue.") as Error & {
      status: number;
    };
    unauthorized.status = 401;
    mocks.requireAuthenticatedProfile.mockRejectedValue(unauthorized);

    const response = await transactionsGET();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in to continue." });
  });

  it("filters the feed to the authenticated participant and redacts internal failure text", async () => {
    const query = transactionQuery({
      data: [
        {
          id: "transaction-1",
          business_profile_id: "profile-1",
          payout_last_error: "Stripe provider details must stay private",
          payout_status: "blocked",
        },
      ],
      error: null,
    });
    const admin = { from: vi.fn().mockReturnValue(query) };
    mocks.requireAuthenticatedProfile.mockResolvedValue({
      profile: { id: "profile-1" },
      admin,
    });

    const response = await transactionsGET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      transactions: [
        {
          id: "transaction-1",
          business_profile_id: "profile-1",
          payout_status: "blocked",
          payout_issue: true,
        },
      ],
    });
    expect(query.or).toHaveBeenCalledWith(
      "business_profile_id.eq.profile-1,creator_profile_id.eq.profile-1",
    );
    expect(query.order).toHaveBeenCalledWith("created_at", { ascending: false });
  });
});

describe("creator review payment route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("validates review input before invoking the database", async () => {
    const response = await reviewPOST(
      reviewRequest({ rating: 6, review: "too short" }),
      reviewContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Choose a rating from 1 to 5." });
    expect(mocks.requireAuthenticatedProfile).not.toHaveBeenCalled();
  });

  it("creates a review through the authenticated payer RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { id: "review-1", rating: 5 },
      error: null,
    });
    const admin = { rpc };
    mocks.requireAuthenticatedProfile.mockResolvedValue({
      profile: { id: "payer-profile" },
      admin,
    });

    const response = await reviewPOST(
      reviewRequest({ rating: 5, review: "Excellent campaign delivery." }),
      reviewContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      review: { id: "review-1", rating: 5 },
    });
    expect(rpc).toHaveBeenCalledWith("create_creator_review", {
      target_transaction_id: transactionId,
      actor_profile_id: "payer-profile",
      review_rating: 5,
      review_body: "Excellent campaign delivery.",
    });
  });

  it("maps a non-payer review attempt to forbidden", async () => {
    const admin = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "Only the payer can review this Creator." },
      }),
    };
    mocks.requireAuthenticatedProfile.mockResolvedValue({
      profile: { id: "creator-profile" },
      admin,
    });

    const response = await reviewPOST(
      reviewRequest({ rating: 5, review: "Excellent campaign delivery." }),
      reviewContext(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Only the payer can review this Creator.",
    });
  });
});
