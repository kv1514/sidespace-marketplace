import { ApiError } from "@/lib/payments/request";
import { claimBudget, requireMember, sameOrigin } from "@/lib/listings/member";
import {
  captureMonth,
  fetchFrame,
  findPanorama,
  streetViewLocation,
} from "@/lib/listings/streetview";

/**
 * A Google Street View frame of a listing's exact address, looked up for the
 * owner while they edit. The Maps key never reaches the browser.
 *
 * The frame that comes back is a preview only. The form keeps the capture
 * month, which is all the listing stores: Google's terms allow keeping
 * nothing of the imagery, so the public listing fetches the frame live from
 * Google through app/api/listings/[listingId]/street-view every time it is
 * shown. Two calls to Google here: metadata first (free) to learn whether
 * outdoor imagery exists near the address, then the frame itself.
 */

const LOOKUPS_PER_HOUR = 30;

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      throw new ApiError("Street View is not set up on this deployment yet.", 503);
    }
    const { profile, admin } = await requireMember("Sign in to add a Street View photo.");
    await claimBudget(
      admin,
      "street_view",
      profile.id,
      LOOKUPS_PER_HOUR,
      3600,
      "That is plenty of Street View lookups for one hour. Try again later.",
    );

    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const address =
      typeof raw?.address === "string"
        ? raw.address.trim().replace(/\s+/g, " ").slice(0, 240)
        : "";
    const city = typeof raw?.city === "string" ? raw.city.trim().slice(0, 80) : "";
    if (address.length < 5) throw new ApiError("Type the exact street address first.");
    const location = streetViewLocation(address, city);

    const meta = await findPanorama(location, key);
    if (meta.status !== "OK") {
      if (meta.status === "ZERO_RESULTS" || meta.status === "NOT_FOUND") {
        throw new ApiError(
          "Google has no Street View of that address. Indoor spots and private buildings usually have none - your own photo is the one that matters.",
          404,
        );
      }
      console.error("[street view] metadata failed", meta.status, meta.error_message);
      throw new ApiError(
        "Street View is not available right now.",
        meta.status === "REQUEST_DENIED" || meta.status === "OVER_QUERY_LIMIT" ? 503 : 502,
      );
    }

    const frame = await fetchFrame(location, key);
    if (!frame) throw new ApiError("Street View is not available right now.", 502);
    const month = captureMonth(meta.date);
    console.info(`[street view] ok captured=${month || "unknown"} bytes=${frame.bytes.byteLength}`);
    return new Response(frame.bytes, {
      headers: {
        "content-type": frame.type,
        "cache-control": "private, no-store",
        "x-street-view-date": month,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("[street view] unexpected", error);
    return Response.json({ error: "Street View is not available right now." }, { status: 500 });
  }
}
