import {
  ApiError,
  errorResponse,
  profileCanReceivePayouts,
  requireAuthenticatedProfile,
  requireSameOrigin,
} from "@/lib/payments/auth";
import { getAppOrigin } from "@/lib/payments/checkout";
import { getStripe, stripeKeyMode } from "@/lib/stripe/server";
import { requireStripeHostedUrl } from "@/lib/stripe/urls";
import { enforcePaymentRateLimit } from "@/lib/payments/rate-limit";

function mapConnectSetupError(error: unknown) {
  if (
    error instanceof Error &&
    /complete your platform profile/i.test(error.message)
  ) {
    return new ApiError(
      "Stripe Connect setup is incomplete. The SideSpace platform owner must finish the live platform profile before payout accounts can be created.",
      503,
    );
  }
  return error;
}

function getPublicBusinessUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!configuredUrl) return undefined;
  try {
    const url = new URL(configuredUrl);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

// Stripe replays the response for an idempotency key, including a previous
// provider-side 4xx. Bump this version when a blocked account-creation
// attempt needs to be retried after the platform configuration is fixed.
const CONNECT_ACCOUNT_IDEMPOTENCY_KEY_VERSION = "v2";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { user, profile, admin } = await requireAuthenticatedProfile();
    if (!profileCanReceivePayouts(profile)) {
      throw new ApiError("Stripe payouts are available to creator profiles.", 403);
    }
    await enforcePaymentRateLimit(admin, {
      bucket: "stripe_connect_onboard",
      profileId: profile.id,
      maxRequests: 5,
      windowSeconds: 10 * 60,
    });
    const origin = getAppOrigin(request.url);
    const stripe = getStripe();
    const livemode = stripeKeyMode() === "live";
    const { data: saved, error: savedError } = await admin
      .from("stripe_accounts")
      .select("profile_id,stripe_connected_account_id")
      .eq("profile_id", profile.id)
      .eq("livemode", livemode)
      .maybeSingle();
    if (savedError) throw savedError;

    let accountId = saved?.stripe_connected_account_id ?? null;
    if (!accountId) {
      const account = await stripe.accounts.create(
        {
          type: "express",
          country: process.env.STRIPE_CONNECT_COUNTRY ?? "US",
          email: profile.contact_email || user.email || undefined,
          capabilities: { transfers: { requested: true } },
          business_profile: {
            product_description: "Advertising inventory and campaign services on SideSpace",
            url: getPublicBusinessUrl(),
          },
          metadata: { sidespace_profile_id: profile.id },
        },
        {
          idempotencyKey: `sidespace-connect-account-${profile.id}-${CONNECT_ACCOUNT_IDEMPOTENCY_KEY_VERSION}`,
        },
      );
      accountId = account.id;
      const accountState = {
        profile_id: profile.id,
        livemode,
        stripe_connected_account_id: account.id,
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        details_submitted: account.details_submitted,
        requirements_due: account.requirements?.currently_due ?? [],
        onboarding_started_at: new Date().toISOString(),
      };
      const { error } = saved
        ? await admin
            .from("stripe_accounts")
            .update(accountState)
            .eq("profile_id", profile.id)
            .eq("livemode", livemode)
        : await admin.from("stripe_accounts").insert(accountState);
      if (error) {
        if (error.code !== "23505") throw error;
        const raced = await admin
          .from("stripe_accounts")
          .select("stripe_connected_account_id")
          .eq("profile_id", profile.id)
          .eq("livemode", livemode)
          .single();
        if (
          raced.error ||
          raced.data?.stripe_connected_account_id !== account.id
        ) {
          throw error;
        }
      }
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: `${origin}/dashboard?connect=refresh`,
      return_url: `${origin}/dashboard?connect=return`,
    });
    return Response.json({
      url: requireStripeHostedUrl(link.url, ["connect.stripe.com"]),
    });
  } catch (error) {
    return errorResponse(mapConnectSetupError(error));
  }
}
