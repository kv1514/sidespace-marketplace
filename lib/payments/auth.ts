import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/payments/request";

export { ApiError, requireSameOrigin, requireUuid } from "@/lib/payments/request";

export async function requireAuthenticatedProfile() {
  const authClient = await createClient();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();
  if (authError || !user) throw new ApiError("Sign in to continue.", 401);

  const admin = createAdminClient();
  const { data: profile, error } = await admin
    .from("profiles")
    .select("id,auth_user_id,display_name,contact_email,onboarding_complete")
    .eq("auth_user_id", user.id)
    .single();
  if (error || !profile) throw new ApiError("Complete your SideSpace profile first.", 403);
  if (!profile.onboarding_complete) {
    throw new ApiError("Complete onboarding before using payments.", 403);
  }

  return { user, profile, admin };
}

export async function requireAuthorizedPaymentsStaff() {
  const authenticated = await requireAuthenticatedProfile();
  const { data: staff, error } = await authenticated.admin
    .from("staff_members")
    .select("auth_user_id,role,active")
    .eq("auth_user_id", authenticated.user.id)
    .eq("active", true)
    .in("role", ["payments_admin", "admin"])
    .maybeSingle();
  if (error || !staff) throw new ApiError("Payments staff authorization is required.", 403);
  return { ...authenticated, staff };
}

export function errorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error("Stripe API route failed", error);
  return Response.json(
    { error: "SideSpace could not complete that payment action." },
    { status: 500 },
  );
}
