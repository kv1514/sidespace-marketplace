import {
  ApiError,
  errorResponse,
  profileCanReceivePayouts,
  requireAuthenticatedProfile,
} from "@/lib/payments/auth";
import { getStripeAccountReadiness } from "@/lib/payments/connect";
import { getStripe } from "@/lib/stripe/server";

function safeAccountStatus(account: {
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
}) {
  const { requirementsDue, ready } = getStripeAccountReadiness(account);
  return {
    connected: true,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    requirementsDue,
    ready,
  };
}

export async function GET() {
  try {
    const { profile, admin } = await requireAuthenticatedProfile();
    if (!profileCanReceivePayouts(profile)) {
      throw new ApiError("Stripe payouts are available to creator profiles.", 403);
    }
    const { data: saved, error: savedError } = await admin
      .from("stripe_accounts")
      .select("stripe_connected_account_id")
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (savedError) throw savedError;
    if (!saved?.stripe_connected_account_id) {
      return Response.json(
        { connected: false, ready: false },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    const account = await getStripe().accounts.retrieve(
      saved.stripe_connected_account_id,
    );
    if (account.deleted) {
      return Response.json(
        { connected: false, ready: false },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const status = safeAccountStatus(account);
    const { error: updateError } = await admin
      .from("stripe_accounts")
      .update({
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        details_submitted: account.details_submitted,
        requirements_due: status.requirementsDue,
        onboarding_completed_at: status.ready ? new Date().toISOString() : null,
      })
      .eq("profile_id", profile.id);
    if (updateError) throw updateError;

    return Response.json(status, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
