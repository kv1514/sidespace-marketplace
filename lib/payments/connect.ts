export type StripeAccountState = {
  /**
   * Not part of readiness. Kept on the type because Stripe returns it and the
   * column stores it, and it is worth being able to read.
   */
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  country?: string | null;
  requirements?: {
    currently_due?: string[] | null;
    past_due?: string[] | null;
    disabled_reason?: string | null;
  } | null;
  requirements_due?: string[] | null;
  capabilities?: { transfers?: string | null } | null;
};

export function getStripeAccountReadiness(account: StripeAccountState) {
  const requirementsDue = Array.from(
    new Set([
      ...(account.requirements?.currently_due ?? []),
      ...(account.requirements_due ?? []),
      ...(account.requirements?.past_due ?? []),
    ]),
  );
  // The database snapshot predates capability storage, so an absent field is
  // allowed there. A live Stripe Account includes capabilities; when present,
  // transfers must be active because Creators only receive later transfers.
  const transfersReady =
    account.capabilities === undefined || account.capabilities?.transfers === "active";
  const countryReady =
    account.country === undefined ||
    account.country === (process.env.STRIPE_CONNECT_COUNTRY ?? "US");
  return {
    requirementsDue,
    // Deliberately does NOT require charges_enabled. The customer is charged on
    // the SideSpace platform account - checkout.ts sets payment_intent_data
    // without a destination and comments that it is "intentionally a platform
    // charge" - and the creator is paid later by stripe.transfers.create with
    // their account as the `destination`. So their account only ever RECEIVES;
    // it never processes a charge.
    //
    // That matters because onboarding requests `capabilities: { transfers: }`
    // and nothing else, and Stripe does not turn on charges_enabled for a
    // transfers-only Express account. Requiring it here made the gate
    // unsatisfiable: a creator could complete onboarding perfectly and every
    // checkout against them would still 409 forever.
    ready:
      account.payouts_enabled &&
      account.details_submitted &&
      countryReady &&
      !account.requirements?.disabled_reason &&
      transfersReady &&
      requirementsDue.length === 0,
  };
}
