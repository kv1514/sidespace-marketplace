import type Stripe from "stripe";

export function assertStripeCheckoutAmounts(input: {
  amountSubtotal: number | null;
  amountTotal: number | null;
  chargedTotalCents: number;
  taxCents: number;
  paymentStatus: string | null;
}) {
  if (input.amountSubtotal !== input.chargedTotalCents) {
    throw new Error("Checkout Session amount does not match the stored ledger.");
  }
  const paid =
    input.paymentStatus === "paid" || input.paymentStatus === "no_payment_required";
  if (paid && input.amountTotal !== input.chargedTotalCents + input.taxCents) {
    throw new Error("Checkout Session total does not match the stored ledger.");
  }
}

export function assertStripeMoneyMatchesLedger(input: {
  objectName: string;
  amount: number | null | undefined;
  currency: string | null | undefined;
  expectedAmountCents: number;
  expectedCurrency: string;
}) {
  if (
    input.amount !== input.expectedAmountCents ||
    input.currency !== input.expectedCurrency
  ) {
    throw new Error(
      `${input.objectName} amount or currency does not match the stored ledger.`,
    );
  }
}

export function isStaleCheckoutSession(
  storedSessionId: string | null,
  receivedSessionId: string,
) {
  return Boolean(storedSessionId && storedSessionId !== receivedSessionId);
}

export function verifyStripeWebhookEvent(
  stripe: Stripe,
  payload: string,
  signature: string,
  webhookSecret: string,
  expectedLivemode = false,
) {
  const event = stripe.webhooks.constructEvent(
    payload,
    signature,
    webhookSecret,
  );
  if (event.livemode !== expectedLivemode) {
    throw new Error("Stripe event mode does not match the configured API keys.");
  }
  return event;
}

export function verifyStripeWebhookEventWithSecrets(
  stripe: Stripe,
  payload: string,
  signature: string,
  webhookSecrets: readonly string[],
  expectedLivemode = false,
) {
  for (const webhookSecret of webhookSecrets) {
    try {
      return verifyStripeWebhookEvent(
        stripe,
        payload,
        signature,
        webhookSecret,
        expectedLivemode,
      );
    } catch {
      // Hosted platform and Connect endpoints have different secrets. Try
      // the other trusted endpoint secret before rejecting the request.
    }
  }
  throw new Error("Invalid Stripe signature.");
}
