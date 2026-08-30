export type StripeAccountState = {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements?: { currently_due?: string[] | null } | null;
  requirements_due?: string[] | null;
};

export function getStripeAccountReadiness(account: StripeAccountState) {
  const requirementsDue =
    account.requirements?.currently_due ?? account.requirements_due ?? [];
  return {
    requirementsDue,
    ready:
      account.charges_enabled &&
      account.payouts_enabled &&
      account.details_submitted &&
      requirementsDue.length === 0,
  };
}
