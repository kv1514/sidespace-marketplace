import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class FounderAccessError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 | 503,
  ) {
    super(message);
  }
}

/**
 * Founder access is keyed by immutable Supabase Auth user IDs, never by an
 * email or display name that can change. Invalid configured values are ignored
 * rather than widening the allowlist.
 */
export function configuredFounderAuthUserIds() {
  return Array.from(
    new Set(
      (process.env.FOUNDER_AUTH_USER_IDS ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter((value) => UUID.test(value)),
    ),
  );
}

export async function requireFounder() {
  const authClient = await createClient();
  const {
    data: { user },
    error,
  } = await authClient.auth.getUser();

  if (error || !user) {
    throw new FounderAccessError("Sign in to continue.", 401);
  }

  const allowedIds = configuredFounderAuthUserIds();
  if (!allowedIds.length) {
    throw new FounderAccessError("The founder dashboard is not configured.", 503);
  }
  if (!allowedIds.includes(user.id.toLowerCase())) {
    throw new FounderAccessError("Founder dashboard access is restricted.", 403);
  }

  return { user, admin: createAdminClient() };
}

export function founderErrorResponse(error: unknown) {
  if (error instanceof FounderAccessError) {
    return Response.json(
      { error: error.message },
      {
        status: error.status,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }

  console.error("Founder KPI request failed", error);
  return Response.json(
    { error: "Founder KPI data is temporarily unavailable." },
    {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
