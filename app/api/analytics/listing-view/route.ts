import { createHmac, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  ApiError,
  requireSameOrigin,
  requireUuid,
} from "@/lib/payments/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VISITOR_COOKIE = "sidespace_analytics_visitor";
const VISITOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const YEAR_IN_SECONDS = 365 * 24 * 60 * 60;
const MAX_BODY_BYTES = 1024;
const ANALYTICS_SECRET_MIN_BYTES = 32;
const REQUESTS_PER_CLIENT_PER_HOUR = 240;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const rateLimits = new Map<string, { startedAt: number; count: number }>();

const cookieName =
  process.env.NODE_ENV === "production"
    ? "__Host-sidespace_analytics_visitor"
    : VISITOR_COOKIE;

function response(recorded: boolean, visitorId: string, shouldSetCookie: boolean, status = 202) {
  const result = NextResponse.json(
    { recorded },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
  if (shouldSetCookie) {
    result.cookies.set(cookieName, visitorId, {
      httpOnly: true,
      maxAge: YEAR_IN_SECONDS,
      path: "/",
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    });
  }
  return result;
}

function hasStrongSecret(secret: string | undefined): secret is string {
  if (!secret) return false;
  return Buffer.byteLength(secret, "utf8") >= ANALYTICS_SECRET_MIN_BYTES;
}

function requestSource(request: Request) {
  return (
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown"
  );
}

/**
 * This is deliberately only a bounded, best-effort abuse guard. The database
 * uniqueness rule remains the correctness boundary for a single visitor and
 * listing; this protects a single server instance from an obvious write flood
 * without persisting raw IP addresses.
 */
function allowRequest(request: Request, secret: string) {
  const source = requestSource(request);
  const rateSubject = source === "unknown" ? "unknown" : source;
  const bucketKey = createHmac("sha256", secret)
    .update(`listing-view-rate:${rateSubject}`)
    .digest("hex");
  const now = Date.now();

  if (rateLimits.size > 5000) {
    rateLimits.clear();
  }
  const current = rateLimits.get(bucketKey);

  if (!current || now - current.startedAt > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(bucketKey, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= REQUESTS_PER_CLIENT_PER_HOUR) return false;
  current.count += 1;
  return true;
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const existing = cookieStore.get(cookieName)?.value ?? "";
  const visitorId = VISITOR_ID.test(existing) ? existing : randomUUID();
  const shouldSetCookie = visitorId !== existing;

  try {
    requireSameOrigin(request);
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new ApiError("Analytics requests must use JSON.", 415);
    }
    const contentLength = request.headers.get("content-length");
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
      throw new ApiError("Analytics request is too large.", 413);
    }

    const body = await request.json().catch(() => null);
    const listingId = requireUuid(body?.listingId, "Choose a listing.");
    const hashSecret = process.env.ANALYTICS_HASH_SECRET;

    // Analytics should never make the marketplace unusable. The event is
    // simply unavailable until the server-side secret is configured.
    if (!hasStrongSecret(hashSecret)) return response(false, visitorId, shouldSetCookie);
    if (!allowRequest(request, hashSecret)) {
      return response(false, visitorId, false, 429);
    }

    const viewerHash = createHmac("sha256", hashSecret)
      .update(visitorId)
      .digest("hex");
    const { data, error } = await createAdminClient().rpc("record_listing_view", {
      target_listing_id: listingId,
      viewer_hash: viewerHash,
    });
    if (error) throw error;
    return response(data === true, visitorId, shouldSetCookie);
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(
        { error: error.message },
        {
          status: error.status,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
    console.error("Listing view analytics failed");
    return response(false, visitorId, shouldSetCookie);
  }
}
