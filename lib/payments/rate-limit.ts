import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "./request";

export async function enforcePaymentRateLimit(
  admin: SupabaseClient,
  input: {
    bucket: string;
    profileId: string;
    maxRequests: number;
    windowSeconds: number;
  },
) {
  const { data, error } = await admin.rpc("claim_payment_rate_limit", {
    rate_bucket: input.bucket,
    subject_profile_id: input.profileId,
    max_requests: input.maxRequests,
    window_seconds: input.windowSeconds,
  });
  if (error) throw error;
  if (data !== true) {
    throw new ApiError("Too many payment attempts. Wait a few minutes and try again.", 429);
  }
}
