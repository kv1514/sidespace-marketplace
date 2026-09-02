import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthenticatedProfile: vi.fn(),
  enforcePaymentRateLimit: vi.fn(),
  getStripe: vi.fn(),
  stripeKeyMode: vi.fn(),
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
    profileCanReceivePayouts: (candidate: {
      role?: string | null;
      extra_roles?: string[] | null;
    }) =>
      [candidate.role, ...(candidate.extra_roles ?? [])].some((role) =>
        ["creator", "space_owner", "sponsor_host"].includes(role ?? ""),
      ),
    requireAuthenticatedProfile: mocks.requireAuthenticatedProfile,
    requireSameOrigin: vi.fn(),
  };
});
vi.mock("@/lib/payments/rate-limit", () => ({
  enforcePaymentRateLimit: mocks.enforcePaymentRateLimit,
}));
vi.mock("@/lib/stripe/server", () => ({
  getStripe: mocks.getStripe,
  stripeKeyMode: mocks.stripeKeyMode,
}));

import { POST as onboardPOST } from "../app/api/stripe/connect/onboard/route";
import { POST as loginPOST } from "../app/api/stripe/connect/login/route";
import { GET as statusGET } from "../app/api/stripe/connect/status/route";

const profile = {
  id: "creator-profile",
  role: "creator",
  extra_roles: [],
  display_name: "Creator",
  contact_email: "creator@example.com",
};

function request(path: string) {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: "{}",
  });
}

function accountLookup(data: unknown) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return query;
}

function authenticatedAdmin(account: unknown) {
  const lookup = accountLookup(account);
  const admin = {
    from: vi.fn((table: string) => {
      if (table !== "stripe_accounts") throw new Error(`Unexpected table ${table}`);
      return lookup;
    }),
  };
  mocks.requireAuthenticatedProfile.mockResolvedValue({
    user: { id: "auth-user", email: "auth@example.com" },
    profile,
    admin,
  });
  return { admin, lookup };
}

function stripeMock() {
  const account = {
    id: "acct_new",
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
    requirements: { currently_due: ["individual.verification.document"] },
  };
  const accounts = {
    create: vi.fn().mockResolvedValue(account),
    retrieve: vi.fn(),
    createLoginLink: vi.fn().mockResolvedValue({
      url: "https://connect.stripe.com/express/acct_existing/login",
    }),
  };
  const accountLinks = {
    create: vi.fn().mockResolvedValue({
      url: "https://connect.stripe.com/setup/acct_new",
    }),
  };
  const stripe = { accounts, accountLinks };
  mocks.getStripe.mockReturnValue(stripe);
  return { stripe, account };
}

describe("Stripe Connect lifecycle routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://sidespace.example");
    vi.stubEnv("STRIPE_CONNECT_COUNTRY", "US");
    mocks.stripeKeyMode.mockReturnValue("test");
    mocks.enforcePaymentRateLimit.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("creates a transfers-only Express account once and returns a hosted onboarding link", async () => {
    const { admin } = authenticatedAdmin(null);
    const { stripe } = stripeMock();
    const inserted: Record<string, unknown>[] = [];
    admin.from.mockImplementation((table: string) => {
      if (table !== "stripe_accounts") throw new Error(`Unexpected table ${table}`);
      return {
        select: accountLookup(null).select,
        eq: accountLookup(null).eq,
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: vi.fn((payload: Record<string, unknown>) => {
          inserted.push(payload);
          return Promise.resolve({ error: null });
        }),
      };
    });

    const response = await onboardPOST(request("/api/stripe/connect/onboard"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://connect.stripe.com/setup/acct_new",
    });
    expect(stripe.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "express",
        country: "US",
        capabilities: { transfers: { requested: true } },
        metadata: { sidespace_profile_id: profile.id },
      }),
      { idempotencyKey: `sidespace-connect-account-${profile.id}` },
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      profile_id: profile.id,
      livemode: false,
      stripe_connected_account_id: "acct_new",
      requirements_due: ["individual.verification.document"],
    });
    expect(stripe.accountLinks.create).toHaveBeenCalledWith({
      account: "acct_new",
      type: "account_onboarding",
      refresh_url: "https://sidespace.example/dashboard?connect=refresh",
      return_url: "https://sidespace.example/dashboard?connect=return",
    });
  });

  it("keeps live Connect accounts separate from sandbox accounts", async () => {
    mocks.stripeKeyMode.mockReturnValue("live");
    const { admin } = authenticatedAdmin(null);
    const { stripe } = stripeMock();
    const inserted: Record<string, unknown>[] = [];
    const lookup = accountLookup(null);
    admin.from.mockReturnValue({
      ...lookup,
      insert: vi.fn((payload: Record<string, unknown>) => {
        inserted.push(payload);
        return Promise.resolve({ error: null });
      }),
    } as unknown as typeof lookup);

    const response = await onboardPOST(request("/api/stripe/connect/onboard"));

    expect(response.status).toBe(200);
    expect(lookup.eq).toHaveBeenCalledWith("livemode", true);
    expect(inserted[0]).toMatchObject({ livemode: true });
    expect(stripe.accounts.create).toHaveBeenCalledTimes(1);
  });

  it("returns an actionable response when Stripe has not approved the live platform", async () => {
    mocks.stripeKeyMode.mockReturnValue("live");
    const { admin } = authenticatedAdmin(null);
    const { stripe } = stripeMock();
    admin.from.mockReturnValue(accountLookup(null));
    stripe.accounts.create.mockRejectedValue(
      Object.assign(
        new Error(
          "You must complete your platform profile to use Connect and create live connected accounts.",
        ),
        { type: "invalid_request_error" },
      ),
    );

    const response = await onboardPOST(request("/api/stripe/connect/onboard"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "Stripe Connect setup is incomplete. The SideSpace platform owner must finish the live platform profile before payout accounts can be created.",
    });
  });

  it("reuses a saved Connect account instead of creating a second one", async () => {
    const account = { profile_id: profile.id, stripe_connected_account_id: "acct_existing" };
    const { admin } = authenticatedAdmin(account);
    const { stripe } = stripeMock();
    const lookup = accountLookup(account);
    admin.from.mockReturnValue(lookup);
    lookup.select.mockReturnValue(lookup);
    lookup.eq.mockReturnValue(lookup);

    const response = await onboardPOST(request("/api/stripe/connect/onboard"));

    expect(response.status).toBe(200);
    expect(stripe.accounts.create).not.toHaveBeenCalled();
    expect(stripe.accountLinks.create).toHaveBeenCalledWith(
      expect.objectContaining({ account: "acct_existing" }),
    );
  });

  it("refreshes and sanitizes Connect status without exposing the account ID", async () => {
    const account = { profile_id: profile.id, stripe_connected_account_id: "acct_existing" };
    const { admin } = authenticatedAdmin(account);
    const { stripe } = stripeMock();
    const lookup = accountLookup(account);
    const updateChain = { eq: vi.fn() };
    updateChain.eq
      .mockReturnValueOnce(updateChain)
      .mockResolvedValueOnce({ error: null });
    const update = vi.fn().mockReturnValue(updateChain);
    admin.from.mockReturnValue({
      select: lookup.select,
      eq: lookup.eq,
      maybeSingle: lookup.maybeSingle,
      update,
    } as unknown as typeof lookup);
    stripe.accounts.retrieve.mockResolvedValue({
      id: "acct_existing",
      country: "US",
      charges_enabled: false,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: [], past_due: [] },
      capabilities: { transfers: "active" },
    });

    const response = await statusGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      connected: true,
      chargesEnabled: false,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirementsDue: [],
      ready: true,
    });
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("stripe_connected_account_id");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        charges_enabled: false,
        payouts_enabled: true,
        details_submitted: true,
        requirements_due: [],
      }),
    );
  });

  it("opens the hosted Express dashboard only for a saved account", async () => {
    const account = { profile_id: profile.id, stripe_connected_account_id: "acct_existing" };
    const { admin } = authenticatedAdmin(account);
    const { stripe } = stripeMock();
    const lookup = accountLookup(account);
    admin.from.mockReturnValue(lookup);

    const response = await loginPOST(request("/api/stripe/connect/login"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://connect.stripe.com/express/acct_existing/login",
    });
    expect(stripe.accounts.createLoginLink).toHaveBeenCalledWith("acct_existing");
  });

  it("does not call Stripe when no Connect account has been saved", async () => {
    const { admin } = authenticatedAdmin(null);
    const { stripe } = stripeMock();
    admin.from.mockReturnValue(accountLookup(null));

    const response = await loginPOST(request("/api/stripe/connect/login"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Set up payouts before opening Stripe.",
    });
    expect(stripe.accounts.createLoginLink).not.toHaveBeenCalled();
  });

  it("blocks payout setup and status access for non-creator profiles", async () => {
    const { admin } = authenticatedAdmin(null);
    const business = { ...profile, role: "business", extra_roles: [] };
    mocks.requireAuthenticatedProfile.mockResolvedValue({
      user: { id: "auth-user", email: "auth@example.com" },
      profile: business,
      admin,
    });
    const { stripe } = stripeMock();

    const onboardResponse = await onboardPOST(request("/api/stripe/connect/onboard"));
    const loginResponse = await loginPOST(request("/api/stripe/connect/login"));
    const statusResponse = await statusGET();

    for (const response of [onboardResponse, loginResponse, statusResponse]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "Stripe payouts are available to creator profiles.",
      });
    }
    expect(stripe.accounts.create).not.toHaveBeenCalled();
    expect(stripe.accounts.createLoginLink).not.toHaveBeenCalled();
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
  });
});
