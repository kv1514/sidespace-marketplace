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
  // contact_email moved to profile_contacts: `profiles` is readable by every
  // anonymous caller, so it cannot hold anyone's address. Read through the
  // service-role client, which is the only role that can see the table.
  const { data: row, error } = await admin
    .from("profiles")
    .select(
      "id,auth_user_id,role,extra_roles,display_name,onboarding_complete,profile_contacts(contact_email)",
    )
    .eq("auth_user_id", user.id)
    .single();
  if (error || !row) throw new ApiError("Complete your SideSpace profile first.", 403);
  if (!row.onboarding_complete) {
    throw new ApiError("Complete onboarding before using payments.", 403);
  }

  const contacts = Array.isArray(row.profile_contacts)
    ? row.profile_contacts[0]
    : row.profile_contacts;
  const profile = {
    id: row.id,
    auth_user_id: row.auth_user_id,
    role: row.role,
    extra_roles: Array.isArray(row.extra_roles) ? row.extra_roles : [],
    display_name: row.display_name,
    onboarding_complete: row.onboarding_complete,
    contact_email: (contacts as { contact_email?: string | null } | null)
      ?.contact_email ?? null,
  };

  return { user, profile, admin };
}

/**
 * A connected account is only useful for a supply-side profile. Keep the
 * legacy supply role values here while the consolidation migration rolls out;
 * `extra_roles` is supported because a member can act as both buyer and
 * creator from one profile.
 */
export function profileCanReceivePayouts(profile: {
  role?: string | null;
  extra_roles?: string[] | null;
}) {
  const supplyRoles = new Set(["creator", "space_owner", "sponsor_host"]);
  return [profile.role, ...(profile.extra_roles ?? [])].some((role) =>
    supplyRoles.has(role ?? ""),
  );
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
