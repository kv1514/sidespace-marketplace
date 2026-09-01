import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const stripeSecret = process.env.STRIPE_SECRET_KEY ?? "";
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const appUrl = process.env.PAYMENTS_E2E_APP_URL ?? "http://127.0.0.1:3000";
const dbContainer = process.env.PAYMENTS_E2E_DB_CONTAINER ?? "supabase_db_vercel-app";
const execFileAsync = promisify(execFile);

let localSupabase = false;
try {
  localSupabase = ["localhost", "127.0.0.1", "::1"].includes(new URL(supabaseUrl).hostname);
} catch {
  // The required-credentials check below reports the actionable failure.
}

if (
  !supabaseUrl ||
  !serviceRoleKey ||
  !stripeSecret.startsWith("sk_test_") ||
  !webhookSecret.startsWith("whsec_") ||
  !localSupabase
) {
  console.error("BLOCKED local recovery E2E — local Supabase and Stripe test credentials are required");
  process.exit(2);
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const stripe = new Stripe(stripeSecret, { maxNetworkRetries: 2 });
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const buyerEmail = `recovery-e2e-buyer-${suffix}@example.invalid`;
const creatorEmail = `recovery-e2e-creator-${suffix}@example.invalid`;
const password = `Recovery-${crypto.randomUUID()}-Aa1!`;
const ids = {
  buyerUser: null,
  creatorUser: null,
  buyerProfile: null,
  creatorProfile: null,
  listing: null,
  campaign: null,
  transaction: crypto.randomUUID(),
};
const stripeObjects = { charge: null, transfer: null, refund: null };
const cleanupErrors = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function purgeLocalFixtureGraph() {
  if (!ids.transaction || !ids.campaign || !ids.listing || !ids.buyerProfile || !ids.creatorProfile) return;
  const transactionId = ids.transaction;
  const campaignId = ids.campaign;
  const listingId = ids.listing;
  const profileIds = [ids.buyerProfile, ids.creatorProfile];
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const transactionIds = quote(transactionId);
  const campaignIds = quote(campaignId);
  const listingIds = quote(listingId);
  const profileIdList = profileIds.map(quote).join(",");
  const sql = [
    "begin",
    "set local session_replication_role = replica",
    `delete from public.payment_fulfillment_events where transaction_id in (${transactionIds})`,
    `delete from public.payment_resolution_actions where transaction_id in (${transactionIds})`,
    `delete from public.payment_disputes where transaction_id in (${transactionIds})`,
    `delete from public.payment_issues where transaction_id in (${transactionIds})`,
    `delete from public.payment_refunds where transaction_id in (${transactionIds})`,
    `delete from public.payment_transfer_reversals where transaction_id in (${transactionIds})`,
    `delete from public.payment_transactions where id in (${transactionIds})`,
    `delete from public.stripe_accounts where profile_id in (${profileIdList})`,
    `delete from public.profile_contacts where profile_id in (${profileIdList})`,
    `delete from public.campaign_requests where id in (${campaignIds})`,
    `delete from public.listings where id in (${listingIds})`,
    `delete from public.profiles where id in (${profileIdList})`,
    "commit",
  ].join("; ");
  try {
    await execFileAsync(
      "docker",
      [
        "exec",
        dbContainer,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        sql,
      ],
      { maxBuffer: 1_000_000 },
    );
  } catch (error) {
    cleanupErrors.push(`local fixture graph: ${error instanceof Error ? error.message : "failed"}`);
  }
}

async function postEvent(event) {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
    timestamp: Math.floor(Date.now() / 1000),
  });
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

async function readyConnectedAccount() {
  const accounts = await stripe.accounts.list({ limit: 100 });
  return accounts.data.find(
    (account) =>
      !account.deleted &&
      account.details_submitted &&
      account.payouts_enabled &&
      account.country === (process.env.STRIPE_CONNECT_COUNTRY ?? "US") &&
      account.capabilities?.transfers === "active" &&
      !(account.requirements?.currently_due ?? []).length &&
      !(account.requirements?.past_due ?? []).length &&
      !account.requirements?.disabled_reason,
  );
}

try {
  const destination = await readyConnectedAccount();
  assert(destination, "no ready sandbox connected account is available");

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
    display_name: "Recovery E2E Buyer",
    onboarding_complete: true,
    is_demo: false,
  }, "id");
  ids.buyerProfile = buyerProfile.id;

  const creatorProfile = await insert("profiles", {
    auth_user_id: ids.creatorUser,
    role: "creator",
    display_name: "Recovery E2E Creator",
    onboarding_complete: true,
    is_demo: false,
  }, "id");
  ids.creatorProfile = creatorProfile.id;

  const listing = await insert("listings", {
    owner_profile_id: ids.creatorProfile,
    title: "Recovery E2E placement",
    channel: "Instagram",
    format: "Story",
    price_cents: 9500,
    price_max_cents: 9500,
    price_unit: "campaign",
    description: "Temporary sandbox listing for post-payout recovery verification.",
    status: "active",
    provenance_status: "owner_attested",
    availability_confirmed_at: new Date().toISOString(),
  }, "id");
  ids.listing = listing.id;

  const campaign = await insert("campaign_requests", {
    listing_id: ids.listing,
    requester_profile_id: ids.buyerProfile,
    owner_profile_id: ids.creatorProfile,
    campaign_name: "Recovery E2E campaign",
    goals: "Verify a real post-payout refund recovery and ledger finalization.",
    requested_deliverables: "One temporary sandbox placement.",
    budget_cents: 9500,
    start_date: "2099-01-01",
    end_date: "2099-01-02",
    status: "confirmed",
    accepted_subtotal_cents: 9500,
    payer_profile_id: ids.buyerProfile,
    payee_profile_id: ids.creatorProfile,
  }, "id");
  ids.campaign = campaign.id;

  await insert("stripe_accounts", {
    profile_id: ids.creatorProfile,
    stripe_connected_account_id: destination.id,
    charges_enabled: Boolean(destination.charges_enabled),
    payouts_enabled: Boolean(destination.payouts_enabled),
    details_submitted: Boolean(destination.details_submitted),
    requirements_due: [],
  }, "profile_id");

  const balance = await stripe.balance.retrieve();
  const availableUsd = balance.available.find((item) => item.currency === "usd")?.amount ?? 0;
  const chargeAmount = Math.max(10_000, 1_200 - availableUsd);
  const subtotal = chargeAmount - 500;
  const creatorPayout = 400;
  const creatorFee = subtotal - creatorPayout;
  const charge = await stripe.charges.create(
    {
      amount: chargeAmount,
      currency: "usd",
      source: "tok_bypassPending",
      description: "SideSpace disposable post-payout recovery source",
      metadata: { sidespace_transaction_id: ids.transaction, codex_e2e_run: suffix },
    },
    { idempotencyKey: `${suffix}-charge` },
  );
  stripeObjects.charge = charge;
  assert(charge.status === "succeeded", `source charge did not succeed: ${charge.status}`);

  const transfer = await stripe.transfers.create(
    {
      amount: creatorPayout,
      currency: "usd",
      destination: destination.id,
      source_transaction: charge.id,
      transfer_group: `sidespace_campaign_${ids.transaction}`,
      metadata: { sidespace_transaction_id: ids.transaction, codex_e2e_run: suffix },
    },
    { idempotencyKey: `${suffix}-transfer` },
  );
  stripeObjects.transfer = transfer;
  assert(transfer.amount === creatorPayout, "source transfer amount did not match the fixture ledger");

  await insert("payment_transactions", {
    id: ids.transaction,
    campaign_request_id: ids.campaign,
    listing_id: ids.listing,
    business_profile_id: ids.buyerProfile,
    creator_profile_id: ids.creatorProfile,
    campaign_name: "Recovery E2E campaign",
    listing_title: "Recovery E2E placement",
    business_name: "Recovery E2E Buyer",
    creator_name: "Recovery E2E Creator",
    currency: "usd",
    subtotal_cents: subtotal,
    buyer_fee_cents: 500,
    creator_fee_cents: creatorFee,
    customer_total_cents: chargeAmount,
    creator_payout_cents: creatorPayout,
    payout_amount_cents: creatorPayout,
    platform_gross_revenue_cents: 500 + creatorFee,
    tax_cents: 0,
    tax_withheld_cents: 0,
    refunded_cents: 0,
    status: "paid",
    workflow_status: "completed",
    payout_status: "released",
    stripe_connected_account_id: destination.id,
    stripe_charge_id: charge.id,
    stripe_transfer_id: transfer.id,
    paid_at: new Date().toISOString(),
    payout_released_at: new Date().toISOString(),
  }, "id");

  const refund = await stripe.refunds.create(
    { charge: charge.id },
    { idempotencyKey: `${suffix}-refund` },
  );
  stripeObjects.refund = refund;
  assert(refund.status === "succeeded", `source refund did not succeed: ${refund.status}`);

  const eventId = `evt_recovery_e2e_${suffix}`;
  const event = {
    id: eventId,
    object: "event",
    api_version: "2025-03-31.basil",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "refund.updated",
    data: { object: refund },
  };

  const first = await postEvent(event);
  assert(first.status === 200 && first.body.received === true, `refund webhook returned ${first.status}`);

  const transaction = await admin
    .from("payment_transactions")
    .select("status,payout_status,payout_recovery_status,payout_recovery_reversed_cents,stripe_transfer_reversal_id")
    .eq("id", ids.transaction)
    .single();
  if (transaction.error || !transaction.data) throw transaction.error ?? new Error("recovery transaction was not found");
  assert(transaction.data.status === "refunded", `transaction status was ${transaction.data.status}`);
  assert(transaction.data.payout_status === "released", `payout status was ${transaction.data.payout_status}`);
  assert(transaction.data.payout_recovery_status === "recovered", `recovery status was ${transaction.data.payout_recovery_status}`);
  assert(transaction.data.payout_recovery_reversed_cents === creatorPayout, "recovered payout amount did not match");
  assert(transaction.data.stripe_transfer_reversal_id, "ledger did not record the transfer reversal");

  const reconciledTransfer = await stripe.transfers.retrieve(transfer.id);
  assert(reconciledTransfer.amount_reversed === creatorPayout, "Stripe transfer was not fully reversed");

  const reversal = await admin
    .from("payment_transfer_reversals")
    .select("status,target_amount_cents,stripe_transfer_reversal_id")
    .eq("transaction_id", ids.transaction)
    .single();
  if (reversal.error || !reversal.data) throw reversal.error ?? new Error("transfer reversal record was not found");
  assert(reversal.data.status === "succeeded", `reversal status was ${reversal.data.status}`);
  assert(reversal.data.target_amount_cents === creatorPayout, "reversal target did not match the payout");
  assert(reversal.data.stripe_transfer_reversal_id, "reversal record did not store the Stripe reversal");

  const storedRefund = await admin
    .from("payment_refunds")
    .select("status,amount_cents")
    .eq("transaction_id", ids.transaction)
    .single();
  if (storedRefund.error || !storedRefund.data) throw storedRefund.error ?? new Error("refund record was not found");
  assert(storedRefund.data.status === "succeeded", `stored refund status was ${storedRefund.data.status}`);
  assert(storedRefund.data.amount_cents === chargeAmount, "stored refund amount did not match the charge");

  const duplicate = await postEvent(event);
  assert(duplicate.status === 200 && duplicate.body.duplicate === true, "duplicate refund webhook was not idempotent");

  console.log("PASS local post-payout recovery — real platform charge, Connect transfer, signed refund webhook, cumulative transfer reversal, ledger finalization, and duplicate idempotency");
} catch (error) {
  console.error(`FAIL local post-payout recovery — ${error instanceof Error ? error.message : "check failed"}`);
  process.exitCode = 1;
} finally {
  if (stripeObjects.transfer) {
    try {
      const current = await stripe.transfers.retrieve(stripeObjects.transfer.id);
      if (current.amount_reversed < current.amount) {
        await stripe.transfers.createReversal(
          current.id,
          { amount: current.amount - current.amount_reversed, metadata: { codex_e2e_cleanup: suffix } },
          { idempotencyKey: `${suffix}-cleanup-reversal` },
        );
      }
    } catch (error) {
      cleanupErrors.push(`Stripe transfer reversal cleanup: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  if (stripeObjects.charge && !stripeObjects.refund) {
    try {
      await stripe.refunds.create(
        { charge: stripeObjects.charge.id },
        { idempotencyKey: `${suffix}-cleanup-refund` },
      );
    } catch (error) {
      cleanupErrors.push(`Stripe charge refund cleanup: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  await purgeLocalFixtureGraph();
  await remove("stripe_webhook_events", "stripe_event_id", `evt_recovery_e2e_${suffix}`);
  await remove("payment_transfer_reversals", "transaction_id", ids.transaction);
  await remove("payment_fulfillment_events", "transaction_id", ids.transaction);
  await remove("payment_refunds", "transaction_id", ids.transaction);
  await remove("payment_disputes", "transaction_id", ids.transaction);
  await remove("payment_issues", "transaction_id", ids.transaction);
  await remove("payment_transactions", "id", ids.transaction);
  await remove("stripe_accounts", "profile_id", ids.creatorProfile);
  await remove("campaign_requests", "id", ids.campaign);
  await remove("listings", "id", ids.listing);
  await remove("profiles", "id", ids.buyerProfile);
  await remove("profiles", "id", ids.creatorProfile);
  for (const userId of [ids.buyerUser, ids.creatorUser]) {
    if (!userId) continue;
    const result = await admin.auth.admin.deleteUser(userId);
    if (result.error) cleanupErrors.push(`auth user: ${result.error.message}`);
  }
  if (cleanupErrors.length) {
    console.error(`CLEANUP FAILED — ${cleanupErrors.length} item(s)`);
    for (const cleanupError of cleanupErrors) console.error(`- ${cleanupError}`);
    process.exitCode = 1;
  } else {
    console.log("CLEANUP PASS — temporary recovery fixture and database rows removed");
  }
}
