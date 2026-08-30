import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthenticatedProfile: vi.fn(),
  getStripe: vi.fn(),
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

vi.mock("@/lib/stripe/server", () => ({ getStripe: mocks.getStripe }));

import { POST } from "../app/api/stripe/checkout/route";

function checkoutRequest() {
  return new Request("http://localhost:3000/api/stripe/checkout", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      campaignRequestId: "123e4567-e89b-42d3-a456-426614174000",
    }),
  });
}

function queryResult(result: unknown) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn().mockResolvedValue(result),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return query;
}

function acceptedCampaign() {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    campaign_name: "Launch week",
    status: "accepted",
    accepted_subtotal_cents: 10_000,
    requester_profile_id: "business-1",
    owner_profile_id: "creator-1",
    listing: {
      id: "listing-1",
      owner_profile_id: "creator-1",
      title: "Three local stories",
      channel: "Instagram",
    },
    requester: { id: "business-1", display_name: "Brea Bakery" },
    owner: { id: "creator-1", display_name: "Maya" },
  };
}

describe("checkout route authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects checkout when there is no authenticated profile", async () => {
    const unauthorized = new Error("Sign in to continue.") as Error & {
      status: number;
    };
    unauthorized.status = 401;
    mocks.requireAuthenticatedProfile.mockRejectedValue(unauthorized);

    const response = await POST(checkoutRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in to continue." });
    expect(mocks.getStripe).not.toHaveBeenCalled();
  });

  it("rejects an unknown campaign before touching Stripe", async () => {
    const campaignQuery = queryResult({
      data: null,
      error: { code: "PGRST116" },
    });
    const admin = { from: vi.fn().mockReturnValue(campaignQuery) };
    mocks.requireAuthenticatedProfile.mockResolvedValue({
      user: { id: "user-1" },
      profile: { id: "profile-1" },
      admin,
    });

    const response = await POST(checkoutRequest());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Campaign request not found." });
    expect(mocks.getStripe).not.toHaveBeenCalled();
  });

  it("blocks payment when the creator has not completed Stripe setup", async () => {
    const campaignQuery = queryResult({
      data: acceptedCampaign(),
      error: null,
    });
    const accountQuery = queryResult({ data: null, error: null });
    const admin = {
      from: vi.fn((table: string) =>
        table === "campaign_requests" ? campaignQuery : accountQuery,
      ),
    };
    mocks.requireAuthenticatedProfile.mockResolvedValue({
      user: { id: "user-1" },
      profile: { id: "business-1" },
      admin,
    });

    const response = await POST(checkoutRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "The creator must finish Stripe payout setup before this campaign can be paid.",
    });
    expect(mocks.getStripe).not.toHaveBeenCalled();
  });
});
