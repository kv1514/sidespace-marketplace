import process from "node:process";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const stripeSecret = process.env.STRIPE_SECRET_KEY ?? "";
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const appUrl = process.env.PAYMENTS_E2E_APP_URL ?? "http://[::1]:3000";

if (
  !supabaseUrl ||
  !serviceRoleKey ||
  !stripeSecret.startsWith("sk_test_") ||
  !webhookSecret.startsWith("whsec_")
) {
  console.error("BLOCKED local webhook E2E — local Supabase and Stripe test credentials are required");
  process.exit(2);
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const stripe = new Stripe(stripeSecret, { maxNetworkRetries: 2 });
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const email = `webhook-e2e-${suffix}@example.invalid`;
const password = `Webhook-${crypto.randomUUID()}-Aa1!`;
const eventId = `evt_webhook_e2e_${suffix}`;
const connectedAccountId = `acct_webhook_e2e_${suffix}`;
const ids = { user: null, profile: null };
const cleanupErrors = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function insert(table, values, select = "*") {
  const result = await admin.from(table).insert(values).select(select).single();
  if (result.error) throw result.error;
  return result.data;
}

async function postEvent(payload, signature) {
  const response = await fetch(`${appUrl}/api/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    // The status is the useful assertion when the route returns non-JSON.
  }
  return { status: response.status, body };
}

try {
  const user = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (user.error || !user.data.user) throw user.error ?? new Error("webhook fixture user was not created");
  ids.user = user.data.user.id;

  const profile = await insert("profiles", {
    auth_user_id: ids.user,
    role: "creator",
    display_name: "Webhook E2E Creator",
    onboarding_complete: true,
    is_demo: false,
  }, "id");
  ids.profile = profile.id;

  await insert("stripe_accounts", {
    profile_id: ids.profile,
    stripe_connected_account_id: connectedAccountId,
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
    requirements_due: ["external_account"],
  }, "profile_id");

  const event = {
    id: eventId,
    object: "event",
    api_version: "2025-03-31.basil",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "account.updated",
    data: {
      object: {
        id: connectedAccountId,
        object: "account",
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        country: "US",
        requirements: {
          currently_due: [],
          past_due: [],
          disabled_reason: null,
        },
        capabilities: { transfers: "active" },
      },
    },
  };
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
    timestamp: Math.floor(Date.now() / 1000),
  });

  const invalidSignature = await postEvent(payload, `${signature}invalid`);
  assert(invalidSignature.status === 400, `invalid signature returned ${invalidSignature.status}`);

  const livePayload = JSON.stringify({ ...event, id: `${eventId}_live`, livemode: true });
  const liveSignature = stripe.webhooks.generateTestHeaderString({
    payload: livePayload,
    secret: webhookSecret,
    timestamp: Math.floor(Date.now() / 1000),
  });
  const wrongMode = await postEvent(livePayload, liveSignature);
  assert(wrongMode.status === 400, `sandbox webhook accepted a live-mode event with status ${wrongMode.status}`);

  const first = await postEvent(payload, signature);
  assert(first.status === 200 && first.body.received === true, `first webhook returned ${first.status}`);

  const account = await admin
    .from("stripe_accounts")
    .select("charges_enabled,payouts_enabled,details_submitted,requirements_due")
    .eq("profile_id", ids.profile)
    .single();
  if (account.error || !account.data) throw account.error ?? new Error("updated account was not found");
  assert(account.data.charges_enabled === true, "account.updated did not persist charges_enabled");
  assert(account.data.payouts_enabled === true, "account.updated did not persist payouts_enabled");
  assert(account.data.details_submitted === true, "account.updated did not persist details_submitted");
  assert(JSON.stringify(account.data.requirements_due) === "[]", "account.updated did not clear requirements_due");

  const duplicate = await postEvent(payload, signature);
  assert(duplicate.status === 200 && duplicate.body.duplicate === true, "duplicate webhook was not acknowledged idempotently");

  const stored = await admin
    .from("stripe_webhook_events")
    .select("status,attempts,livemode,event_type")
    .eq("stripe_event_id", eventId)
    .single();
  if (stored.error || !stored.data) throw stored.error ?? new Error("webhook event was not persisted");
  assert(stored.data.status === "processed", `webhook event status was ${stored.data.status}`);
  assert(stored.data.attempts === 1, `duplicate webhook changed attempts to ${stored.data.attempts}`);
  assert(stored.data.livemode === false && stored.data.event_type === "account.updated", "webhook metadata was incorrect");

  console.log("PASS local signed webhook — account.updated persistence, signature verification, and duplicate idempotency");
} catch (error) {
  console.error(`FAIL local signed webhook — ${error instanceof Error ? error.message : "check failed"}`);
  process.exitCode = 1;
} finally {
  const event = await admin.from("stripe_webhook_events").delete().eq("stripe_event_id", eventId);
  if (event.error) cleanupErrors.push(`webhook event: ${event.error.message}`);
  if (ids.profile) {
    const account = await admin.from("stripe_accounts").delete().eq("profile_id", ids.profile);
    if (account.error) cleanupErrors.push(`stripe account: ${account.error.message}`);
    const profile = await admin.from("profiles").delete().eq("id", ids.profile);
    if (profile.error) cleanupErrors.push(`profile: ${profile.error.message}`);
  }
  if (ids.user) {
    const user = await admin.auth.admin.deleteUser(ids.user);
    if (user.error) cleanupErrors.push(`auth user: ${user.error.message}`);
  }
  if (cleanupErrors.length) {
    console.error(`CLEANUP FAILED — ${cleanupErrors.length} item(s)`);
    process.exitCode = 1;
  } else {
    console.log("CLEANUP PASS — temporary webhook fixture removed");
  }
}
