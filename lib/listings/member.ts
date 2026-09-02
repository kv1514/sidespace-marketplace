import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/payments/request";

/**
 * Guards shared by the listing-editor routes (Fill with AI, Street View):
 * the request came from our own pages, and a signed-in member with a
 * finished profile sent it. Each route used to carry its own copy.
 */

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(request.url).origin;
  if (!origin || origin !== expected) {
    throw new ApiError("This request did not come from SideSpace.", 403);
  }
}

export async function requireMember(signInMessage: string) {
  const authClient = await createClient();
  const {
    data: { user },
    error,
  } = await authClient.auth.getUser();
  if (error || !user) throw new ApiError(signInMessage, 401);

  const admin = createAdminClient();
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id,city")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) throw new ApiError("Finish setting up your profile first.", 403);
  return { profile: profile as { id: string; city: string | null }, admin };
}

/**
 * Take one unit from a member's hourly budget on the shared rate-limit
 * table; throws the given message with 429 once the window is spent.
 */
export async function claimBudget(
  admin: ReturnType<typeof createAdminClient>,
  bucket: string,
  profileId: string,
  maxRequests: number,
  windowSeconds: number,
  spentMessage: string,
) {
  const { data: allowed, error } = await admin.rpc("claim_payment_rate_limit", {
    rate_bucket: bucket,
    subject_profile_id: profileId,
    max_requests: maxRequests,
    window_seconds: windowSeconds,
  });
  if (error) throw error;
  if (!allowed) throw new ApiError(spentMessage, 429);
}
