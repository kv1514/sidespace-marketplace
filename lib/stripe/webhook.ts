import type Stripe from "stripe";

export function verifyStripeWebhookEvent(
  stripe: Stripe,
  payload: string,
  signature: string,
  webhookSecret: string,
) {
  const event = stripe.webhooks.constructEvent(
    payload,
    signature,
    webhookSecret,
  );
  if (event.livemode) {
    throw new Error("Live-mode events are disabled.");
  }
  return event;
}
