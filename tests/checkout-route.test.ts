import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthenticatedProfile: vi.fn(),
  getStripe: vi.fn(),
  stripeKeyMode: vi.fn(() => "test"),
  enforcePaymentRateLimit: vi.fn(),
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
    profileCanReceivePayouts: (candidate: {
      role?: string | null;
      extra_roles?: string[] | null;
    }) =>
      [candidate.role, ...(candidate.extra_roles ?? [])].some((role) =>
        ["creator", "space_owner", "sponsor_host"].includes(role ?? ""),
      ),
    requireSameOrigin: vi.fn(),
    requireUuid: (value: unknown) => String(value),
  };
});

vi.mock("@/lib/stripe/server", () => ({
  getStripe: mocks.getStripe,
  stripeKeyMode: mocks.stripeKeyMode,
}));
vi.mock("@/lib/payments/rate-limit", () => ({
  enforcePaymentRateLimit: mocks.enforcePaymentRateLimit,
}));

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
    payer_profile_id: "business-1",
    payee_profile_id: "creator-1",
    listing: {
      id: "listing-1",
      owner_profile_id: "creator-1",
      title: "Three local stories",
      channel: "Instagram",
      provenance_status: "owner_attested",
      availability_confirmed_at: new Date().toISOString(),
    },
    requester: {
      id: "business-1",
      display_name: "Brea Bakery",
      role: "business",
      extra_roles: [],
    },
    owner: {
      id: "creator-1",
      display_name: "Maya",
      role: "creator",
      extra_roles: [],
    },
  };
}

describe("checkout route authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  afterEach(() => vi.unstubAllEnvs());

  it("fails closed when the production Checkout kill switch is off", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYMENTS_CHECKOUT_ENABLED", "false");

    const response = await POST(checkoutRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Payments are temporarily unavailable.",
    });
    expect(mocks.requireAuthenticatedProfile).not.toHaveBeenCalled();
    expect(mocks.getStripe).not.toHaveBeenCalled();
  });

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

  it.each([
    { date: "2026-02-30", conflict: false, status: 400 },
    { date: "2026-09-06", conflict: true, status: 409 },
  ])("rejects invalid or unavailable instant dates before Stripe ($status)", async ({ date, conflict, status }) => {
    const admin = { rpc: vi.fn().mockResolvedValue({ error: { message: "These dates were just booked." } }), from: vi.fn() };
    mocks.requireAuthenticatedProfile.mockResolvedValue({ user: {}, profile: { id: "trusted-buyer" }, admin });
    const response = await POST(new Request("http://localhost:3000/api/stripe/checkout", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ listingId: "listing-1", bookingDate: date, listingUpdatedAt: "2026-09-03T12:00:00Z" }),
    }));
    expect(response.status).toBe(status);
    expect(admin.rpc).toHaveBeenCalledTimes(conflict ? 1 : 0);
    expect(admin.from).not.toHaveBeenCalled();
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

  it("blocks checkout when the trusted payee is not a creator profile", async () => {
    const campaign = acceptedCampaign();
    campaign.owner = {
      id: "creator-1",
      display_name: "Former Business",
      role: "business",
      extra_roles: [],
    };
    const campaignQuery = queryResult({ data: campaign, error: null });
    const admin = { from: vi.fn().mockReturnValue(campaignQuery) };
    mocks.requireAuthenticatedProfile.mockResolvedValue({
      user: { id: "user-1" },
      profile: { id: "business-1" },
      admin,
    });

    const response = await POST(checkoutRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The campaign payee must have a creator profile before checkout.",
    });
    expect(mocks.getStripe).not.toHaveBeenCalled();
  });

  // Every guard above short-circuits before the ledger insert, which is how
  // `payout_amount_cents` came to be missing from it without a test noticing:
  // the column is NOT NULL with no default, so the first real checkout for any
  // campaign died on a Postgres 23502 that surfaced as a generic 500. This
  // drives the route all the way to the insert and asserts the payload carries
  // every column the schema requires, rather than only the one that regressed.
  it.each([
    { mode: "test" as const, livemode: false, instant: false, credit: 0 },
    { mode: "test" as const, livemode: false, instant: false, credit: 5000 },
    { mode: "test" as const, livemode: false, instant: false, credit: 10500 },
    { mode: "live" as const, livemode: true, instant: false },
    { mode: "test" as const, livemode: false, instant: true },
    { mode: "live" as const, livemode: true, instant: true },
  ])(
    "returns a Stripe checkout URL and writes every column the schema requires in $mode mode (instant=$instant)",
    async ({ mode, livemode, instant, credit = 0 }) => {
    // From 20260830060711 and 20260830120000: NOT NULL, no default, and not
    // generated. Kept as a literal so adding such a column to the table
    // without adding it here is a failing test rather than a 500 in production.
    const REQUIRED_COLUMNS = [
      "campaign_request_id",
      "listing_id",
      "business_profile_id",
      "creator_profile_id",
      "campaign_name",
      "listing_title",
      "business_name",
      "creator_name",
      "subtotal_cents",
      "buyer_fee_cents",
      "creator_fee_cents",
      "customer_total_cents",
      "ad_credit_cents",
      "creator_payout_cents",
      "payout_amount_cents",
      "platform_gross_revenue_cents",
      "stripe_connected_account_id",
    ];

    const readyAccount = {
      stripe_connected_account_id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements_due: [],
      capabilities: { transfers: "active" },
    };

    let insertPayload: Record<string, unknown> | null = null;

    const campaignQuery = queryResult({ data: { ...acceptedCampaign(), instant_booking: instant }, error: null });
    const holdExpiry = "2026-09-03T12:45:00Z";
    // stripe_accounts is read twice: the creator's payout account, then the
    // payer's customer record. Giving the payer an existing customer id keeps
    // this test on the path it is actually about - the ledger insert - instead
    // of the customer-creation branch.
    const creatorAccountQuery = queryResult({ data: readyAccount, error: null });
    const payerAccountQuery = queryResult({
      data: { profile_id: "business-1", stripe_customer_id: "cus_existing" },
      error: null,
    });
    let stripeAccountReads = 0;

    // payment_transactions: first the "does one already exist" lookup (no), then
    // the insert whose payload this test exists to inspect.
    // The row the insert is expected to return, shaped like transactionColumns.
    const insertedRow = {
      id: "txn-1",
      status: "requires_checkout",
      checkout_attempt: 0,
      stripe_checkout_session_id: null,
      currency: "usd",
      subtotal_cents: 10_000,
      buyer_fee_cents: 500,
      creator_fee_cents: 500,
      customer_total_cents: 10_500,
      ad_credit_cents: 0,
      charged_total_cents: 10_500,
      creator_payout_cents: 9_500,
      payout_amount_cents: 9_500,
      platform_gross_revenue_cents: 1_000,
      stripe_connected_account_id: "acct_ready",
      business_profile_id: "business-1",
      creator_profile_id: "creator-1",
    };
    // The final UPDATE ends in .in(...), which is what gets awaited.
    const updateChain = {
      eq: vi.fn(),
      in: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: insertedRow, error: null }),
    };
    updateChain.eq.mockReturnValue(updateChain);
    updateChain.in.mockReturnValue(updateChain);
    updateChain.select.mockReturnValue(updateChain);

    const transactionQuery: Record<string, ReturnType<typeof vi.fn>> = {
      select: vi.fn(),
      eq: vi.fn(),
      // First read: "does a transaction already exist for this campaign?" - no.
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      // Read after the insert: the row just written.
      single: vi.fn().mockResolvedValue({ data: insertedRow, error: null }),
      insert: vi.fn((payload: Record<string, unknown>) => {
        insertPayload = payload;
        return transactionQuery;
      }),
      update: vi.fn(() => updateChain),
    };
    transactionQuery.select.mockReturnValue(transactionQuery);
    transactionQuery.eq.mockReturnValue(transactionQuery);

    const admin = {
    from: vi.fn((table: string) => {
        if (table === "campaign_requests") return campaignQuery;
    if (table === "stripe_accounts") {
          stripeAccountReads += 1;
        return stripeAccountReads === 1 ? creatorAccountQuery : payerAccountQuery;
      }
      return transactionQuery;
    }),
    rpc: vi.fn(async (name: string) => {
      if (name === "reserve_listing_booking") return { data: acceptedCampaign().id, error: null };
      if (name === "begin_listing_booking_checkout") return { data: holdExpiry, error: null };
      return { data: { reserved_cents: credit, charged_total_cents: 10_500 - credit }, error: null };
    }),
  };
    mocks.requireAuthenticatedProfile.mockResolvedValue({
      user: { id: "user-1", email: "buyer@example.com" },
      profile: {
        id: "business-1",
        display_name: "Brea Bakery",
        contact_email: "buyer@example.com",
      },
      admin,
    });
    mocks.stripeKeyMode.mockReturnValue(mode);
    mocks.getStripe.mockReturnValue({
      accounts: { retrieve: vi.fn().mockResolvedValue(readyAccount) },
      customers: { create: vi.fn().mockResolvedValue({ id: "cus_test" }) },
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue({
            id: "cs_test",
            status: "open",
            url: "https://checkout.stripe.com/c/pay/cs_test",
            livemode,
            expires_at: 0,
          }),
        },
      },
    });

    const response = await POST(instant ? new Request("http://localhost:3000/api/stripe/checkout", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ listingId: "listing-1", bookingDate: "2026-09-06", listingUpdatedAt: "2026-09-03T12:00:00Z", priceCents: 1, buyerProfileId: "attacker" }),
    }) : checkoutRequest());
    if (instant) {
      expect(admin.rpc).toHaveBeenCalledWith("reserve_listing_booking", {
        target_listing_id: "listing-1", buyer_profile_id: "business-1", booking_date: "2026-09-06",
        expected_updated_at: "2026-09-03T12:00:00Z", payment_livemode: livemode,
      });
      expect(admin.rpc).toHaveBeenCalledWith("begin_listing_booking_checkout", { target_campaign_id: acceptedCampaign().id });
      expect(mocks.getStripe().checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ expires_at: Date.parse(holdExpiry) / 1000 }), expect.anything());
      expect(admin.rpc.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.getStripe().checkout.sessions.create.mock.invocationCallOrder[0]);
    }

    // The whole point: a real Stripe-hosted checkout URL comes back.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://checkout.stripe.com/c/pay/cs_test",
      reused: false,
    });

    // Read through a fresh binding: the assignment happens inside the insert
    // mock, which TypeScript's control-flow analysis cannot see, so it narrows
    // the captured variable to null and then to never.
    const payload = insertPayload as Record<string, unknown> | null;
    expect(payload).not.toBeNull();
    const supplied = Object.keys(payload ?? {});
    expect(REQUIRED_COLUMNS.filter((c) => !supplied.includes(c))).toEqual([]);
    const params = mocks.getStripe().checkout.sessions.create.mock.calls[0][0];
    expect(params.metadata.sidespace_ad_credit_cents).toBe(String(credit));
    expect(params.line_items.reduce((sum: number, item: { price_data: { unit_amount: number } }) => sum + item.price_data.unit_amount, 0)).toBe(10500 - credit);
    expect(admin.rpc).toHaveBeenCalledWith("reserve_business_ad_credit", {
      target_business_profile_id: "business-1", target_transaction_id: "txn-1", maximum_cents: 10500,
    });
    // The release transfers this amount; creator_payout_cents is its ceiling.
    expect(payload?.payout_amount_cents).toBe(payload?.creator_payout_cents);
    },
  );
});
