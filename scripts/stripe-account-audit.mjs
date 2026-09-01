import process from "node:process";
import Stripe from "stripe";

const requestedMode = process.argv[2] === "live" ? "live" : "sandbox";
const secret = process.env.STRIPE_SECRET_KEY ?? "";
const expectedPrefix = requestedMode === "live" ? "sk_live_" : "sk_test_";
if (!secret.startsWith(expectedPrefix)) {
  console.error(`BLOCKED  Stripe key mode — expected ${expectedPrefix}…`);
  process.exit(1);
}

const stripe = new Stripe(secret, { maxNetworkRetries: 2 });
const results = [];

async function audit(name, action) {
  try {
    const detail = await action();
    results.push({ name, pass: true, detail });
  } catch (error) {
    results.push({
      name,
      pass: false,
      detail: error instanceof Error ? error.message : "check failed",
    });
  }
}

await audit("Platform account", async () => {
  const account = await stripe.accounts.retrieve();
  const ready =
    !account.deleted &&
    account.details_submitted &&
    account.charges_enabled &&
    account.payouts_enabled &&
    !(account.requirements?.currently_due ?? []).length &&
    !(account.requirements?.past_due ?? []).length &&
    !account.requirements?.disabled_reason;
  if (!ready) throw new Error("platform onboarding, charges, or payouts are incomplete");
  return `ready in ${account.country ?? "unknown country"}`;
});

await audit("Connect", async () => {
  const accounts = await stripe.accounts.list({ limit: 100 });
  const ready = accounts.data.filter(
    (account) =>
      !account.deleted &&
      account.details_submitted &&
      account.payouts_enabled &&
      account.country === (process.env.STRIPE_CONNECT_COUNTRY ?? "US") &&
      account.capabilities?.transfers === "active" &&
      !(account.requirements?.currently_due ?? []).length &&
      !(account.requirements?.past_due ?? []).length &&
      !account.requirements?.disabled_reason,
  ).length;
  if (!ready) throw new Error("no fully enabled connected account exists for an end-to-end test");
  return `${ready}/${accounts.data.length} connected accounts ready`;
});

const requiredPlatformEvents = [
  "checkout.session.completed",
  "checkout.session.expired",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
];

function normalizedWebhookUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

await audit("Webhooks", async () => {
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const expectedWebhookUrl = normalizedWebhookUrl(
    process.env.STRIPE_WEBHOOK_URL ??
      (process.env.NEXT_PUBLIC_APP_URL
        ? `${process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/api/stripe/webhook`
        : ""),
  );
  const expectedLivemode = requestedMode === "live";
  const enabled = (endpoint, event) =>
    endpoint.status === "enabled" &&
    endpoint.livemode === expectedLivemode &&
    normalizedWebhookUrl(endpoint.url) === expectedWebhookUrl &&
    (endpoint.enabled_events.includes("*") || endpoint.enabled_events.includes(event));
  const platform = endpoints.data.filter(
    (endpoint) => !endpoint.connect && endpoint.status === "enabled",
  );
  const connected = endpoints.data.filter(
    (endpoint) => endpoint.connect && endpoint.status === "enabled",
  );
  const missing = requiredPlatformEvents.filter(
    (event) => !platform.some((endpoint) => enabled(endpoint, event)),
  );
  if (!connected.some((endpoint) => enabled(endpoint, "account.updated"))) {
    missing.push("connected account.updated");
  }
  if (!expectedWebhookUrl) {
    missing.push("configured webhook URL");
  } else {
    if (!platform.some((endpoint) => normalizedWebhookUrl(endpoint.url) === expectedWebhookUrl)) {
      missing.push("platform webhook URL");
    }
    if (!connected.some((endpoint) => normalizedWebhookUrl(endpoint.url) === expectedWebhookUrl)) {
      missing.push("connected webhook URL");
    }
  }
  if (missing.length) throw new Error(`missing enabled events: ${missing.join(", ")}`);
  return `${platform.length} platform and ${connected.length} connected endpoints checked at ${expectedWebhookUrl}`;
});

await audit("Stripe Tax", async () => {
  await Promise.all([
    stripe.taxCodes.retrieve(process.env.STRIPE_CAMPAIGN_TAX_CODE ?? "missing"),
    stripe.taxCodes.retrieve(process.env.STRIPE_SERVICE_FEE_TAX_CODE ?? "missing"),
  ]);
  const registrations = await stripe.tax.registrations.list({ status: "active", limit: 100 });
  if (!registrations.data.length) {
    throw new Error("tax codes exist, but there are no active Stripe Tax registrations");
  }
  return `${registrations.data.length} active registrations and both tax codes found`;
});

await audit("Balance access", async () => {
  const balance = await stripe.balance.retrieve();
  return `${balance.available.length} available and ${balance.pending.length} pending currency balances`;
});

await audit("Refund visibility", async () => {
  const refunds = await stripe.refunds.list({ limit: 1 });
  return refunds.data.length ? "at least one refund is visible" : "API access works; no refund evidence yet";
});

await audit("Dispute visibility", async () => {
  const disputes = await stripe.disputes.list({ limit: 1 });
  return disputes.data.length ? "at least one dispute is visible" : "API access works; no dispute evidence yet";
});

for (const result of results) {
  console.log(`${result.pass ? "PASS" : "BLOCKED"}  ${result.name} — ${result.detail}`);
}
const blockers = results.filter((result) => !result.pass);
console.log(`\n${results.length - blockers.length}/${results.length} Stripe ${requestedMode} checks passed.`);
if (blockers.length) process.exitCode = 1;
