/**
 * Google Street View Static API, server side only. The Maps key stays here.
 *
 * Google's Maps Platform terms allow no storing, caching, or re-hosting of
 * Street View imagery - only a panorama id may be kept - so nothing in this
 * module or its callers writes a frame anywhere. The editor shows a
 * transient preview, the listing page fetches the frame per view through a
 * pass-through route, and the listing row keeps only the month the frame was
 * captured, for the caption and as the on/off switch.
 */

export const STREET_VIEW_IMAGE_URL = "https://maps.googleapis.com/maps/api/streetview";
export const STREET_VIEW_METADATA_URL = `${STREET_VIEW_IMAGE_URL}/metadata`;

/**
 * Google's default search radius in metres, then one wider try for an
 * address set back from the road. Metadata lookups are free, so the second
 * try costs nothing when the first finds imagery.
 */
const RADII = ["50", "120"];

export type StreetViewMetadata = {
  status?: string;
  date?: string;
  pano_id?: string;
  error_message?: string;
};

/** A bare street address resolves better with the city on it. */
export function streetViewLocation(address: string, city: string) {
  const trimmed = address.trim().replace(/\s+/g, " ");
  const town = city.trim();
  return town && !trimmed.toLowerCase().includes(town.toLowerCase())
    ? `${trimmed}, ${town}`
    : trimmed;
}

/** "2023-05" from Google, "May 2023" for the caption. */
export function captureMonth(date: string | undefined) {
  if (!date || !/^\d{4}-\d{2}/.test(date)) return "";
  const parsed = new Date(`${date.slice(0, 7)}-15T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * Is there outdoor imagery near this address, and when was it taken? Free.
 * Returns Google's last answer when none was found, so the caller can tell a
 * plain miss (ZERO_RESULTS, NOT_FOUND) from a key or quota problem.
 */
export async function findPanorama(location: string, key: string): Promise<StreetViewMetadata> {
  let last: StreetViewMetadata = {};
  for (const radius of RADII) {
    const params = new URLSearchParams({ location, source: "outdoor", radius, key });
    const response = await fetch(`${STREET_VIEW_METADATA_URL}?${params}`);
    const json = (await response.json().catch(() => ({}))) as StreetViewMetadata;
    if (response.ok && json.status === "OK") return json;
    last = json;
    // Only a plain miss is worth a wider look; a denied key stays denied.
    if (json.status !== "ZERO_RESULTS") break;
  }
  return last;
}

/**
 * One 640x400 outdoor frame aimed at the address. Given a location rather
 * than a panorama id, Google points the camera at the address itself, which
 * is what a buyer wants to see. Null when Google declines.
 */
export async function fetchFrame(
  location: string,
  key: string,
): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const params = new URLSearchParams({
    location,
    source: "outdoor",
    size: "640x400",
    fov: "90",
    key,
  });
  const response = await fetch(`${STREET_VIEW_IMAGE_URL}?${params}`);
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !type.startsWith("image/")) {
    console.error("[street view] frame failed", response.status, type);
    return null;
  }
  return { bytes: await response.arrayBuffer(), type };
}
