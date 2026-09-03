import { createAdminClient } from "@/lib/supabase/admin";
import { fetchFrame, streetViewLocation } from "@/lib/listings/streetview";

/**
 * The Street View card on a listing page. Fetched from Google on every view
 * and passed straight through: Google's terms allow no storing or caching of
 * the imagery, so this route keeps nothing and tells browsers and the CDN to
 * keep nothing either.
 *
 * Public because listings are. A frame is served only for a listing whose
 * owner attached Street View, from the address they entered, so the key can
 * never be pointed at an arbitrary place. A soft per-IP limit keeps a script
 * from running up the Google bill; the daily quota on the key in Google
 * Cloud is the hard stop.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEWS_PER_IP_PER_HOUR = 120;
const hits = new Map<string, { started: number; count: number }>();

function allowed(ip: string) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.started > 3_600_000) {
    // A long-lived instance would otherwise grow this forever.
    if (hits.size > 5000) hits.clear();
    hits.set(ip, { started: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= VIEWS_PER_IP_PER_HOUR;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ listingId: string }> },
) {
  const { listingId } = await params;
  if (!UUID.test(listingId)) return new Response(null, { status: 404 });
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return new Response(null, { status: 404 });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!allowed(ip)) return new Response(null, { status: 429 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("listings")
    .select("status,street_address,street_view_captured,location_area")
    .eq("id", listingId)
    .maybeSingle();
  if (error) {
    console.error("[street view card] lookup failed", error);
    return new Response(null, { status: 500 });
  }
  const listing = data as {
    status: string;
    street_address: string | null;
    street_view_captured: string | null;
    location_area: string | null;
  } | null;
  // Paused listings are only ever seen by their owner, in the editor.
  if (
    !listing ||
    !["active", "paused"].includes(listing.status) ||
    !listing.street_view_captured ||
    !listing.street_address
  ) {
    return new Response(null, { status: 404 });
  }

  const frame = await fetchFrame(
    streetViewLocation(listing.street_address, listing.location_area ?? ""),
    key,
  );
  if (!frame) return new Response(null, { status: 502 });
  return new Response(frame.bytes, {
    headers: {
      "content-type": frame.type,
      "cache-control": "private, no-store, max-age=0",
    },
  });
}
