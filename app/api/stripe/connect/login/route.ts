import {
  ApiError,
  errorResponse,
  profileCanReceivePayouts,
  requireAuthenticatedProfile,
  requireSameOrigin,
} from "@/lib/payments/auth";
import { getStripe } from "@/lib/stripe/server";
import { requireStripeHostedUrl } from "@/lib/stripe/urls";
import { enforcePaymentRateLimit } from "@/lib/payments/rate-limit";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { profile, admin } = await requireAuthenticatedProfile();
    if (!profileCanReceivePayouts(profile)) {
      throw new ApiError("Stripe payouts are available to creator profiles.", 403);
    }
    await enforcePaymentRateLimit(admin, {
      bucket: "stripe_connect_login",
      profileId: profile.id,
      maxRequests: 10,
      windowSeconds: 10 * 60,
    });
    const { data: saved, error: savedError } = await admin
      .from("stripe_accounts")
      .select("stripe_connected_account_id")
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (savedError) throw savedError;
    if (!saved?.stripe_connected_account_id) {
      throw new ApiError("Set up payouts before opening Stripe.", 409);
    }
    const link = await getStripe().accounts.createLoginLink(
      saved.stripe_connected_account_id,
    );
    return Response.json({
      url: requireStripeHostedUrl(link.url, ["connect.stripe.com"]),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
