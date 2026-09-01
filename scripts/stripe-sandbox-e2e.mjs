import process from "node:process";
import Stripe from "stripe";

const secret = process.env.STRIPE_SECRET_KEY ?? "";
const confirmed = process.argv.includes("--confirm-sandbox");

if (!confirmed) {
  console.error("BLOCKED  provider E2E — pass --confirm-sandbox to allow test-mode mutations");
  process.exit(2);
}

if (!secret.startsWith("sk_test_")) {
  console.error("BLOCKED  provider E2E — only a Stripe test secret is accepted");
  process.exit(2);
}

const stripe = new Stripe(secret, { maxNetworkRetries: 2 });
const run = `codex-payments-e2e-${Date.now()}`;
const results = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chargeId(paymentIntent) {
  const value = paymentIntent?.latest_charge;
  return typeof value === "string" ? value : value?.id ?? null;
}

function safeError(error) {
  const raw = String(error?.message ?? error?.raw?.message ?? "").toLowerCase();
  const category = /onboard|platform|account|capabilit|charge|payment method/.test(raw)
    ? "account_or_payment_capability_boundary"
    : /parameter|request/.test(raw)
      ? "request_shape_or_parameter"
      : "provider_rejection";
  return {
    category,
    type: error?.type ?? error?.constructor?.name ?? "unknown",
    message: String(error?.message ?? error?.raw?.message ?? "").slice(0, 240),
    code: error?.code ?? null,
    declineCode: error?.decline_code ?? null,
    param: error?.param ?? null,
    statusCode: error?.statusCode ?? null,
    paymentIntentStatus:
      error?.payment_intent?.status ?? error?.paymentIntent?.status ?? null,
  };
}

async function test(name, action) {
  try {
    results.push({ name, pass: true, detail: await action() });
  } catch (error) {
    results.push({ name, pass: false, detail: safeError(error) });
  }
}

async function createCardPayment(label, paymentMethod, amount = 500, extra = {}) {
  return stripe.paymentIntents.create(
    {
      amount,
      currency: "usd",
      // Keep direct PaymentIntent scenarios aligned with the app's launch
      // Checkout contract. The account Dashboard may enable redirect-based
      // methods globally; without this explicit list Stripe requires a
      // return_url even though every scenario below is intentionally card-only.
      payment_method_types: ["card"],
      // Stripe's supported server-side test surface is a PaymentMethod ID;
      // raw card numbers are intentionally rejected by many test accounts.
      payment_method: paymentMethod,
      confirm: true,
      description: `Sandbox payment test ${label}`,
      metadata: { codex_e2e_run: run, test_case: label },
      ...extra,
    },
    { idempotencyKey: `${run}-pi-${label}` },
  );
}

async function createAvailableBalanceCharge(label, amount = 10_000) {
  // Stripe test transfers require available balance. The documented bypass
  // token settles directly into that balance, so this transfer test is not
  // coupled to whatever pending/refunded objects a sandbox already contains.
  return stripe.charges.create(
    {
      amount,
      currency: "usd",
      source: "tok_bypassPending",
      description: `Sandbox available-balance transfer source ${label}`,
      metadata: { codex_e2e_run: run, test_case: label },
    },
    { idempotencyKey: `${run}-charge-${label}` },
  );
}

async function expectDecline(label, number, expectedDeclineCode = null) {
  try {
    const paymentIntent = await createCardPayment(label, number);
    if (paymentIntent.status === "succeeded") {
      throw new Error("decline test unexpectedly succeeded");
    }
    return { status: paymentIntent.status, acceptedFailure: true };
  } catch (error) {
    const detail = safeError(error);
    if (!detail.code && !detail.declineCode && !detail.paymentIntentStatus) {
      throw error;
    }
    if (detail.paymentIntentStatus === "succeeded") {
      throw new Error("decline test unexpectedly succeeded");
    }
    if (expectedDeclineCode && detail.declineCode !== expectedDeclineCode) {
      throw new Error(`expected ${expectedDeclineCode}, received ${detail.declineCode ?? "none"}`);
    }
    return {
      status: detail.paymentIntentStatus ?? "provider_rejected",
      errorCode: detail.code,
      declineCode: detail.declineCode,
      acceptedFailure: true,
    };
  }
}

async function asyncRefundScenario(label, number, expectedInitial, expectedTerminal) {
  const paymentIntent = await createCardPayment(label, number);
  if (paymentIntent.status !== "succeeded") {
    throw new Error(`payment did not succeed: ${paymentIntent.status}`);
  }
  const created = await stripe.refunds.create(
    { payment_intent: paymentIntent.id },
    { idempotencyKey: `${run}-refund-${label}` },
  );
  let current = created.status;
  // Stripe intentionally does not promise an exact test-mode transition
  // time for asynchronous refunds. Give the provider a full minute before
  // calling a still-pending refund a harness failure.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (current === expectedTerminal) break;
    await sleep(1000);
    current = (await stripe.refunds.retrieve(created.id)).status;
  }
  if (created.status !== expectedInitial || current !== expectedTerminal) {
    throw new Error(`initial ${created.status}, observed ${current}`);
  }
  return { initialStatus: created.status, terminalStatus: current };
}

await test("successful card payment", async () => {
  const paymentIntent = await createCardPayment("success", "pm_card_visa");
  if (paymentIntent.status !== "succeeded") {
    throw new Error(`unexpected status ${paymentIntent.status}`);
  }
  return { status: paymentIntent.status, chargeCreated: Boolean(chargeId(paymentIntent)) };
});

await test("PaymentIntent idempotency", async () => {
  const first = await createCardPayment("idempotency", "pm_card_visa");
  const second = await createCardPayment("idempotency", "pm_card_visa");
  if (first.id !== second.id || first.status !== "succeeded") {
    throw new Error("PaymentIntent idempotency failed");
  }
  const refund = await stripe.refunds.create(
    { payment_intent: first.id },
    { idempotencyKey: `${run}-refund-idempotency-cleanup` },
  );
  return { sameObject: true, status: first.status, cleanupRefund: refund.status };
});

await test("3DS required payment remains actionable", async () => {
  const paymentIntent = await createCardPayment(
    "3ds-required",
    "pm_card_threeDSecure2Required",
  );
  if (paymentIntent.status !== "requires_action") {
    throw new Error(`expected requires_action, received ${paymentIntent.status}`);
  }
  return { status: paymentIntent.status, nextAction: paymentIntent.next_action?.type ?? null };
});

await test("generic card decline", () =>
  expectDecline("generic-decline", "pm_card_visa_chargeDeclined", "generic_decline"));

await test("insufficient-funds decline", () =>
  expectDecline(
    "insufficient-funds",
    "pm_card_visa_chargeDeclinedInsufficientFunds",
    "insufficient_funds",
  ));

await test("3DS-required decline", () =>
  expectDecline("3ds-decline", "pm_card_threeDSecureRequiredChargeDeclined"));

await test("full refund and refund idempotency", async () => {
  const paymentIntent = await createCardPayment("full-refund", "pm_card_visa");
  const first = await stripe.refunds.create(
    { payment_intent: paymentIntent.id },
    { idempotencyKey: `${run}-refund-full` },
  );
  const second = await stripe.refunds.create(
    { payment_intent: paymentIntent.id },
    { idempotencyKey: `${run}-refund-full` },
  );
  if (first.id !== second.id || first.status !== "succeeded") {
    throw new Error("full refund was not successful and idempotent");
  }
  return { status: first.status, sameObject: true };
});

await test("partial refund plus remainder", async () => {
  const paymentIntent = await createCardPayment("partial-refund", "pm_card_visa", 800);
  const partial = await stripe.refunds.create(
    { payment_intent: paymentIntent.id, amount: 300 },
    { idempotencyKey: `${run}-refund-partial` },
  );
  const remainder = await stripe.refunds.create(
    { payment_intent: paymentIntent.id, amount: 500 },
    { idempotencyKey: `${run}-refund-remainder` },
  );
  if (partial.status !== "succeeded" || partial.amount !== 300 || remainder.status !== "succeeded") {
    throw new Error("partial or remainder refund did not settle");
  }
  return { partialStatus: partial.status, partialAmount: partial.amount, remainderStatus: remainder.status };
});

await test("asynchronous refund success", () =>
  asyncRefundScenario("async-refund-success", "pm_card_pendingRefund", "pending", "succeeded"));

await test("asynchronous refund failure", () =>
  asyncRefundScenario("async-refund-failure", "pm_card_refundFail", "succeeded", "failed"));

await test("Checkout Session creation and expiry", async () => {
  const productData = { name: "Sandbox payment lifecycle test" };
  if (process.env.STRIPE_CAMPAIGN_TAX_CODE) {
    productData.tax_code = process.env.STRIPE_CAMPAIGN_TAX_CODE;
  }
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: { currency: "usd", unit_amount: 500, product_data: productData },
        },
      ],
      automatic_tax: { enabled: true },
      invoice_creation: { enabled: true },
      payment_intent_data: {
        transfer_group: `${run}-checkout`,
        metadata: { codex_e2e_run: run, test_case: "checkout" },
      },
      success_url: "https://example.com/sandbox-success",
      cancel_url: "https://example.com/sandbox-cancel",
      metadata: { codex_e2e_run: run, test_case: "checkout" },
    },
    { idempotencyKey: `${run}-checkout` },
  );
  if (session.status !== "open") throw new Error(`expected open, received ${session.status}`);
  const expired = await stripe.checkout.sessions.expire(session.id);
  if (expired.status !== "expired") throw new Error(`expected expired, received ${expired.status}`);
  return { created: session.status, afterExpire: expired.status };
});

await test("dispute trigger and evidence submission", async () => {
  const paymentIntent = await createCardPayment("dispute", "pm_card_createDispute");
  if (paymentIntent.status !== "succeeded") {
    throw new Error(`dispute trigger payment did not succeed: ${paymentIntent.status}`);
  }
  const targetCharge = chargeId(paymentIntent);
  let dispute = null;
  for (let attempt = 0; attempt < 15 && !dispute; attempt += 1) {
    const listed = await stripe.disputes.list({ limit: 100 });
    dispute = listed.data.find((item) => item.charge === targetCharge) ?? null;
    if (!dispute) await sleep(1000);
  }
  if (!dispute) throw new Error("test dispute did not become visible during the polling window");
  const updated = await stripe.disputes.update(dispute.id, {
    evidence: { uncategorized_text: "winning_evidence" },
  });
  return {
    paymentStatus: paymentIntent.status,
    disputeStatus: dispute.status,
    evidenceSubmitted: Boolean(updated.evidence?.uncategorized_text),
  };
});

await test("separate charge and transfer with transfer_group", async () => {
  const accounts = await stripe.accounts.list({ limit: 100 });
  const destination = accounts.data.find(
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
  if (!destination) throw new Error("no transfer-ready test connected account");
  const transferGroup = `${run}-transfer`;
  const balance = await stripe.balance.retrieve();
  const availableUsd = balance.available.find((item) => item.currency === "usd")?.amount ?? 0;
  // Leave room for Stripe fees and balance rounding before the $4 transfer.
  // The source charge is refunded in finally, so this is only temporary test
  // balance and prevents an already-negative sandbox from starving the test.
  const sourceAmount = Math.max(20_000, 2_000 - availableUsd);
  const sourceCharge = await createAvailableBalanceCharge("transfer-source", sourceAmount);
  try {
    if (sourceCharge.status !== "succeeded") {
      throw new Error(`transfer source charge did not succeed: ${sourceCharge.status}`);
    }
    const transfer = await stripe.transfers.create(
      {
        amount: 400,
        currency: "usd",
        destination: destination.id,
        source_transaction: sourceCharge.id,
        transfer_group: transferGroup,
        metadata: { codex_e2e_run: run, test_case: "transfer" },
      },
      { idempotencyKey: `${run}-transfer` },
    );
    if (transfer.amount !== 400 || transfer.transfer_group !== transferGroup) {
      throw new Error("transfer identity did not round-trip");
    }
    const reversal = await stripe.transfers.createReversal(
      transfer.id,
      { amount: 400, metadata: { codex_e2e_run: run, test_case: "transfer-reversal" } },
      { idempotencyKey: `${run}-transfer-reversal` },
    );
    return {
      transferCreated: true,
      transferAmount: transfer.amount,
      reversalAmount: reversal.amount,
      sourceChargeRefunded: true,
    };
  } finally {
    const refund = await stripe.refunds.create(
      { charge: sourceCharge.id },
      { idempotencyKey: `${run}-transfer-source-refund` },
    );
    if (refund.status !== "succeeded") {
      throw new Error(`transfer source cleanup refund did not succeed: ${refund.status}`);
    }
  }
});

for (const result of results) {
  console.log(`${result.pass ? "PASS" : "BLOCKED"}  ${result.name} — ${JSON.stringify(result.detail)}`);
}

const blocked = results.filter((result) => !result.pass);
console.log(`\n${results.length - blocked.length}/${results.length} Stripe sandbox provider scenarios passed.`);
if (blocked.length) process.exitCode = 1;
