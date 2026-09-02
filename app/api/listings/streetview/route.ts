import { ApiError } from "@/lib/payments/request";
import { claimBudget, requireMember, sameOrigin } from "@/lib/listings/member";

/**
 * A Google Street View frame of a listing's exact address, fetched here so
 * the Maps key never reaches the browser. The form adds the JPEG to the
 * listing's photos, and Fill with AI reads it for the surroundings.
 *
 * Two calls to Google: metadata first (free) to learn whether outdoor
 * imagery exists at the address, then the frame itself. Nothing is stored
 * server-side; the photo goes through the normal upload on Publish.
 */

const METADATA_URL = "https://maps.googleapis.com/maps/api/streetview/metadata";
const IMAGE_URL = "https://maps.googleapis.com/maps/api/streetview";
const LOOKUPS_PER_HOUR = 30;

/** "2023-05" from Google, "May 2023" for the caption. */
function captureMonth(date: string | undefined) {
  if (!date || !/^\d{4}-\d{2}/.test(date)) return "";
  const parsed = new Date(`${date.slice(0, 7)}-15T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

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
    // A bare street address resolves better with the city on it.
    const location =
      city && !address.toLowerCase().includes(city.toLowerCase())
        ? `${address}, ${city}`
        : address;

    const metaParams = new URLSearchParams({ location, source: "outdoor", key });
    const meta = await fetch(`${METADATA_URL}?${metaParams}`);
    const metaJson = (await meta.json().catch(() => ({}))) as {
      status?: string;
      date?: string;
      error_message?: string;
    };
    if (!meta.ok || metaJson.status !== "OK") {
      if (metaJson.status === "ZERO_RESULTS" || metaJson.status === "NOT_FOUND") {
        throw new ApiError(
          "Google has no Street View of that address. Indoor spots and private buildings usually have none - your own photo is the one that matters.",
          404,
        );
      }
      console.error(
        "[street view] metadata failed",
        meta.status,
        metaJson.status,
        metaJson.error_message,
      );
      throw new ApiError(
        "Street View is not available right now.",
        metaJson.status === "REQUEST_DENIED" || metaJson.status === "OVER_QUERY_LIMIT" ? 503 : 502,
      );
    }

    const imageParams = new URLSearchParams({
      location,
      source: "outdoor",
      size: "640x400",
      fov: "90",
      key,
    });
    const image = await fetch(`${IMAGE_URL}?${imageParams}`);
    const type = image.headers.get("content-type") ?? "";
    if (!image.ok || !type.startsWith("image/")) {
      console.error("[street view] image failed", image.status, type);
      throw new ApiError("Street View is not available right now.", 502);
    }
    const bytes = await image.arrayBuffer();
    const month = captureMonth(metaJson.date);
    console.info(`[street view] ok captured=${month || "unknown"} bytes=${bytes.byteLength}`);
    return new Response(bytes, {
      headers: {
        "content-type": type,
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
