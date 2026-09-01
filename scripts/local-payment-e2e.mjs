import process from "node:process";
import Stripe from "stripe";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const stripeSecret = process.env.STRIPE_SECRET_KEY ?? "";
const appUrl = process.env.PAYMENTS_E2E_APP_URL ?? "http://[::1]:3000";
const origin = process.env.PAYMENTS_E2E_ORIGIN ?? "http://localhost:3000";

if (!baseUrl || !publishableKey || !serviceRoleKey || !stripeSecret.startsWith("sk_test_")) {
  console.error("BLOCKED local payment E2E — local Supabase and Stripe test credentials are required");
  process.exit(2);
}

const admin = createClient(baseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const stripe = new Stripe(stripeSecret, { maxNetworkRetries: 2 });
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const buyerEmail = `payments-e2e-buyer-${suffix}@example.invalid`;
const creatorEmail = `payments-e2e-creator-${suffix}@example.invalid`;
const password = `E2e-${crypto.randomUUID()}-Aa1!`;
const ids = { buyerUser: null, creatorUser: null, buyerProfile: null, creatorProfile: null, listing: null, campaign: null, transaction: null };
const stripeObjects = { customer: null, sessions: [] };
const cleanupErrors = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function authCookies() {
  const jar = new Map();
  const client = createServerClient(baseUrl, publishableKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (items) => items.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  return { client, header: () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ") };
}

async function insert(table, values, select = "*") {
  const result = await admin.from(table).insert(values).select(select).single();
  if (result.error) throw result.error;
  return result.data;
}

async function remove(table, column, value) {
  if (!value) return;
  const result = await admin.from(table).delete().eq(column, value);
  if (result.error) cleanupErrors.push(`${table}: ${result.error.message}`);
}

async function routeJson(path, { cookie = "", requestOrigin = origin, body } = {}) {
  const response = await fetch(`${appUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: requestOrigin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  return { status: response.status, payload };
}

async function findReadyConnectedAccount() {
  const accounts = await stripe.accounts.list({ limit: 100 });
  return accounts.data.find((account) => {
    const due = [
      ...(account.requirements?.currently_due ?? []),
      ...(account.requirements?.past_due ?? []),
    ];
    return (
      !account.deleted &&
      account.details_submitted &&
      account.payouts_enabled &&
      account.country === (process.env.STRIPE_CONNECT_COUNTRY ?? "US") &&
      account.capabilities?.transfers === "active" &&
      due.length === 0 &&
      !account.requirements?.disabled_reason
    );
  });
}

async function listCampaignSessions(customerId, campaignId) {
  const listed = await stripe.checkout.sessions.list({ customer: customerId, limit: 100 });
  return listed.data
    .filter((session) => session.metadata?.sidespace_campaign_request_id === campaignId)
    .sort((a, b) => a.created - b.created);
}

let session;
try {
  const connected = await findReadyConnectedAccount();
  assert(connected, "no ready sandbox connected account is available");

  const buyer = await admin.auth.admin.createUser({
    email: buyerEmail,
    password,
    email_confirm: true,
  });
  if (buyer.error || !buyer.data.user) throw buyer.error ?? new Error("buyer user was not created");
  ids.buyerUser = buyer.data.user.id;

  const creator = await admin.auth.admin.createUser({
    email: creatorEmail,
    password,
    email_confirm: true,
  });
  if (creator.error || !creator.data.user) throw creator.error ?? new Error("creator user was not created");
  ids.creatorUser = creator.data.user.id;

  const buyerProfile = await insert("profiles", {
    auth_user_id: ids.buyerUser,
    role: "business",
    display_name: "Payments E2E Buyer",
    onboarding_complete: true,
    is_demo: false,
  }, "id");
  ids.buyerProfile = buyerProfile.id;

  const creatorProfile = await insert("profiles", {
    auth_user_id: ids.creatorUser,
    role: "creator",
    display_name: "Payments E2E Creator",
    onboarding_complete: true,
    is_demo: false,
  }, "id");
  ids.creatorProfile = creatorProfile.id;

  await insert("profile_contacts", {
    profile_id: ids.buyerProfile,
    contact_email: buyerEmail,
    contact_name: "Payments E2E Buyer",
  }, "profile_id");

  const listing = await insert("listings", {
    owner_profile_id: ids.creatorProfile,
    title: "Payments E2E creator placement",
    channel: "Instagram",
    format: "Story",
    price_cents: 10000,
    price_max_cents: 10000,
    price_unit: "campaign",
    description: "Temporary sandbox listing for payment route verification.",
    status: "active",
    provenance_status: "owner_attested",
    availability_confirmed_at: new Date().toISOString(),
  }, "id");
  ids.listing = listing.id;

  const campaign = await insert("campaign_requests", {
    listing_id: ids.listing,
    requester_profile_id: ids.buyerProfile,
    owner_profile_id: ids.creatorProfile,
    campaign_name: "Payments E2E campaign",
    goals: "Verify the complete sandbox checkout lifecycle and database ledger behavior.",
    requested_deliverables: "One sandbox campaign placement.",
    budget_cents: 10000,
    start_date: "2099-01-01",
    end_date: "2099-01-02",
    status: "accepted",
    accepted_subtotal_cents: 10000,
    payer_profile_id: ids.buyerProfile,
    payee_profile_id: ids.creatorProfile,
  }, "id");
  ids.campaign = campaign.id;

  await insert("stripe_accounts", {
    profile_id: ids.creatorProfile,
    stripe_connected_account_id: connected.id,
    charges_enabled: Boolean(connected.charges_enabled),
    payouts_enabled: Boolean(connected.payouts_enabled),
    details_submitted: Boolean(connected.details_submitted),
    requirements_due: [],
  }, "profile_id");

  stripeObjects.customer = await stripe.customers.create({
    email: buyerEmail,
    name: "Payments E2E Buyer",
    metadata: { codex_payment_e2e: suffix },
  });
  await insert("stripe_accounts", {
    profile_id: ids.buyerProfile,
    stripe_customer_id: stripeObjects.customer.id,
  }, "profile_id");

  const auth = authCookies();
  const signedIn = await auth.client.auth.signInWithPassword({ email: buyerEmail, password });
  if (signedIn.error) throw signedIn.error;
  const cookie = auth.header();
  assert(cookie, "Supabase session cookie was not set");

  const hostile = await routeJson("/api/stripe/checkout", {
    cookie,
    requestOrigin: "https://evil.example",
    body: { campaignRequestId: ids.campaign },
  });
  assert(hostile.status === 403, `hostile origin returned ${hostile.status}`);

  const first = await routeJson("/api/stripe/checkout", {
    cookie,
    body: { campaignRequestId: ids.campaign },
  });
  assert(first.status === 200, `first checkout returned ${first.status}: ${first.payload.error ?? "unknown"}`);
  assert(first.payload.reused === false, "first checkout was unexpectedly reused");
  assert(new URL(first.payload.url).hostname === "checkout.stripe.com", "checkout URL host was not Stripe");

  const firstSessions = await listCampaignSessions(stripeObjects.customer.id, ids.campaign);
  assert(firstSessions.length === 1 && firstSessions[0].status === "open", "first Checkout Session was not open");
  session = firstSessions[0];
  stripeObjects.sessions.push(session);

  const firstTransaction = await admin
    .from("payment_transactions")
    .select("id")
    .eq("campaign_request_id", ids.campaign)
    .single();
  if (firstTransaction.error || !firstTransaction.data) {
    throw firstTransaction.error ?? new Error("payment transaction was not written");
  }
  ids.transaction = firstTransaction.data.id;

  const configuredSession = await stripe.checkout.sessions.retrieve(session.id);
  assert(configuredSession.mode === "payment", "Checkout Session mode was not payment");
  assert(
    configuredSession.payment_method_types?.length === 1 &&
      configuredSession.payment_method_types[0] === "card",
    "Checkout Session was not card-only",
  );
  assert(configuredSession.automatic_tax?.enabled === true, "automatic tax was not enabled");
  assert(configuredSession.invoice_creation?.enabled === true, "invoice creation was not enabled");
  assert(configuredSession.client_reference_id === ids.transaction, "Checkout client reference was not the ledger transaction");
  assert(
    configuredSession.metadata?.sidespace_transaction_id === ids.transaction &&
      configuredSession.metadata?.sidespace_campaign_request_id === ids.campaign,
    "Checkout metadata did not identify the trusted campaign",
  );
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 10,
  });
  const lineItemAmounts = lineItems.data
    .map((item) => item.price?.unit_amount)
    .sort((left, right) => (left ?? 0) - (right ?? 0));
  assert(
    lineItemAmounts.length === 2 &&
      lineItemAmounts[0] === 500 &&
      lineItemAmounts[1] === 10_000,
    "Checkout line items did not preserve the trusted subtotal and buyer fee",
  );

  const replay = await routeJson("/api/stripe/checkout", {
    cookie,
    body: { campaignRequestId: ids.campaign },
  });
  assert(replay.status === 200 && replay.payload.reused === true, "same checkout request did not reuse the open session");

  const expired = await stripe.checkout.sessions.expire(session.id);
  assert(expired.status === "expired", `first Checkout Session did not expire: ${expired.status}`);

  const retry = await routeJson("/api/stripe/checkout", {
    cookie,
    body: { campaignRequestId: ids.campaign },
  });
  assert(retry.status === 200 && retry.payload.reused === false, `expired checkout retry returned ${retry.status}`);
  assert(new URL(retry.payload.url).hostname === "checkout.stripe.com", "retry checkout URL host was not Stripe");

  const allSessions = await listCampaignSessions(stripeObjects.customer.id, ids.campaign);
  assert(allSessions.length === 2, `expected two Checkout Sessions, found ${allSessions.length}`);
  const second = allSessions[1];
  stripeObjects.sessions.push(second);
  assert(second.status === "open", "retry Checkout Session was not open");

  const transaction = await admin
    .from("payment_transactions")
    .select("id,status,checkout_attempt,stripe_checkout_session_id,subtotal_cents,buyer_fee_cents,creator_fee_cents,customer_total_cents,creator_payout_cents,payout_amount_cents")
    .eq("campaign_request_id", ids.campaign)
    .single();
  if (transaction.error || !transaction.data) throw transaction.error ?? new Error("payment transaction was not written");
  ids.transaction = transaction.data.id;
  assert(transaction.data.status === "checkout_open", `ledger status was ${transaction.data.status}`);
  assert(transaction.data.checkout_attempt === 1, `checkout attempt was ${transaction.data.checkout_attempt}`);
  assert(transaction.data.stripe_checkout_session_id === second.id, "ledger did not point to retry session");
  assert(transaction.data.subtotal_cents === 10000, "subtotal snapshot changed");
  assert(transaction.data.customer_total_cents === transaction.data.subtotal_cents + transaction.data.buyer_fee_cents, "buyer fee math failed");
  assert(transaction.data.creator_payout_cents === transaction.data.subtotal_cents - transaction.data.creator_fee_cents, "creator payout math failed");
  assert(transaction.data.payout_amount_cents === transaction.data.creator_payout_cents, "payout amount snapshot failed");

  await stripe.checkout.sessions.expire(second.id);
  console.log("PASS local authenticated checkout — origin protection, auth, trusted campaign snapshot, card-only Checkout, automatic tax, invoice creation, line-item cents, replay idempotency, expiry recovery, retry attempt, and ledger math");
} catch (error) {
  console.error(`FAIL local authenticated checkout — ${error instanceof Error ? error.message : "check failed"}`);
  process.exitCode = 1;
} finally {
  for (const item of stripeObjects.sessions) {
    if (item.status === "open") {
      try {
        await stripe.checkout.sessions.expire(item.id);
      } catch {
        // Cleanup is best effort; the ledger and fixture cleanup below still run.
      }
    }
  }
  if (stripeObjects.customer) {
    try {
      await stripe.customers.del(stripeObjects.customer.id);
    } catch (error) {
      cleanupErrors.push(`Stripe customer: ${error instanceof Error ? "delete failed" : "cleanup failed"}`);
    }
  }
  await remove("payment_transactions", "campaign_request_id", ids.campaign);
  await remove("stripe_accounts", "profile_id", ids.buyerProfile);
  await remove("stripe_accounts", "profile_id", ids.creatorProfile);
  await remove("campaign_requests", "id", ids.campaign);
  await remove("listings", "id", ids.listing);
  await remove("profile_contacts", "profile_id", ids.buyerProfile);
  await remove("profiles", "id", ids.buyerProfile);
  await remove("profiles", "id", ids.creatorProfile);
  for (const userId of [ids.buyerUser, ids.creatorUser]) {
    if (!userId) continue;
    const result = await admin.auth.admin.deleteUser(userId);
    if (result.error) cleanupErrors.push(`auth user: ${result.error.message}`);
  }
  if (cleanupErrors.length) {
    console.error(`CLEANUP FAILED — ${cleanupErrors.length} item(s)`);
    process.exitCode = 1;
  } else {
    console.log("CLEANUP PASS — temporary auth, database, customer, and Checkout objects removed");
  }
}
