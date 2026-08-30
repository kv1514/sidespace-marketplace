import {
  ApiError,
  errorResponse,
  requireAuthenticatedProfile,
  requireSameOrigin,
} from "@/lib/payments/auth";
import { getStripe } from "@/lib/stripe/server";
import { requireStripeHostedUrl } from "@/lib/stripe/urls";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { profile, admin } = await requireAuthenticatedProfile();
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
