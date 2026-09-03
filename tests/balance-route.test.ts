import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), stripe: vi.fn(), mode: vi.fn(), promo: vi.fn() }));
vi.mock("@/lib/payments/auth", () => ({
  requireAuthenticatedProfile: mocks.auth,
  profileCanReceivePayouts: (p: { role: string; extra_roles?: string[] }) => [p.role, ...(p.extra_roles ?? [])].includes("creator"),
  errorResponse: (error: Error & { status?: number }) => Response.json({ error: error.message }, { status: error.status ?? 500 }),
}));
vi.mock("@/lib/stripe/server", () => ({ getStripe: mocks.stripe, stripeKeyMode: mocks.mode }));
vi.mock("@/lib/payments/balance-server", async (importOriginal) => ({ ...(await importOriginal<object>()), readPromoBalance: mocks.promo }));
import { GET } from "../app/api/payments/balance/route";

function setup(connected = true, role = "creator") {
  const account = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: connected ? { stripe_connected_account_id: "acct_own" } : null, error: null }) };
  account.select.mockReturnValue(account); account.eq.mockReturnValue(account);
  const transactions = { select: vi.fn(), eq: vi.fn(), order: vi.fn(), range: vi.fn().mockResolvedValue({ data: [], count: 0, error: null }) };
  transactions.select.mockReturnValue(transactions); transactions.eq.mockReturnValue(transactions); transactions.order.mockReturnValue(transactions);
  const admin = { from: vi.fn((table) => table === "stripe_accounts" ? account : transactions) };
  mocks.auth.mockResolvedValue({ profile: { id: "own-profile", role }, admin });
  const stripe = {
    accounts: { retrieve: vi.fn().mockResolvedValue({ id: "acct_own", payouts_enabled: true }) },
    balance: { retrieve: vi.fn().mockResolvedValue({ livemode: true, available: [{ currency: "usd", amount: 12300 }], pending: [{ currency: "usd", amount: 400 }] }) },
  };
  mocks.stripe.mockReturnValue(stripe);
  return { account, transactions, admin, stripe };
}
describe("private balance route", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.mode.mockReturnValue("live"); mocks.promo.mockResolvedValue({ eligible: true, balanceCents: 2500, activity: [] }); });
  it("binds balances and earnings to the authenticated profile and matching Stripe mode", async () => {
    const { account, transactions, stripe } = setup();
    const response = await GET(); const body = await response.json();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(account.eq).toHaveBeenCalledWith("profile_id", "own-profile");
    expect(account.eq).toHaveBeenCalledWith("livemode", true);
    expect(transactions.eq).toHaveBeenCalledWith("creator_profile_id", "own-profile");
    expect(transactions.eq).toHaveBeenCalledWith("stripe_connected_account_id", "acct_own");
    expect(stripe.balance.retrieve).toHaveBeenCalledWith({}, { stripeAccount: "acct_own" });
    expect(body.stripe.balances[0]).toEqual({ currency: "usd", availableCents: 12300, pendingCents: 400 });
    expect(JSON.stringify(body)).not.toContain("acct_own");
  });
  it("does not retrieve the platform balance for someone without a connected account", async () => {
    const { stripe } = setup(false);
    expect((await (await GET()).json()).stripe.status).toBe("not_connected");
    expect(stripe.balance.retrieve).not.toHaveBeenCalled();
  });
  it("leaves promo credit visible when Stripe is unavailable", async () => {
    const { stripe } = setup(); stripe.balance.retrieve.mockRejectedValue(new Error("Stripe unavailable"));
    const body = await (await GET()).json();
    expect(body.stripe.status).toBe("unavailable"); expect(body.promo.balanceCents).toBe(2500);
  });
  it("does not present an unavailable credit ledger as a zero balance", async () => {
    setup(); mocks.promo.mockRejectedValue(new Error("Ledger unavailable"));
    const body = await (await GET()).json(); expect(body.promo).toBeNull(); expect(body.stripe.status).toBe("connected");
  });
  it("does not query Stripe for a buyer-only account", async () => {
    const { admin } = setup(false, "business");
    expect((await (await GET()).json()).stripe.status).toBe("not_eligible");
    expect(admin.from).not.toHaveBeenCalled(); expect(mocks.stripe).not.toHaveBeenCalled();
  });
  it("rejects signed-out access before querying financial data", async () => {
    mocks.auth.mockRejectedValue(Object.assign(new Error("Sign in"), { status: 401 }));
    expect((await GET()).status).toBe(401); expect(mocks.promo).not.toHaveBeenCalled();
  });
});
