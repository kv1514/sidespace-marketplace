import { formatPlaceLabel, isPopulatedPlace, type GeoPlace } from "./places";

const USER_AGENT =
  "SideSpace/1.0 (https://sidespace.ad; sidespacesupport@gmail.com)";

type OpenMeteoHit = {
  id?: number;
  name?: string;
  latitude?: number;
  longitude?: number;
  country_code?: string;
  country?: string;
  admin1?: string;
  feature_code?: string;
};

type PhotonFeature = {
  geometry?: { coordinates?: number[] };
  properties?: {
    osm_id?: number;
    osm_type?: string;
    osm_value?: string;
    name?: string;
    city?: string;
    state?: string;
    country?: string;
    countrycode?: string;
    type?: string;
  };
};

const SKIP_OSM_VALUES = new Set(["house", "street", "highway", "other"]);

function headers() {
  return { Accept: "application/json", "User-Agent": USER_AGENT };
}

function placeId(prefix: string, id: string) {
  return `${prefix}:${id}`;
}

function fromOpenMeteo(hit: OpenMeteoHit): GeoPlace | null {
  const name = hit.name?.trim();
  if (!name || !isPopulatedPlace(hit.feature_code)) return null;
  if (
    typeof hit.latitude !== "number" ||
    typeof hit.longitude !== "number" ||
    !Number.isFinite(hit.latitude) ||
    !Number.isFinite(hit.longitude)
  ) {
    return null;
  }
  return {
    id: placeId("om", String(hit.id ?? `${name}:${hit.latitude}:${hit.longitude}`)),
    city: name,
    label: formatPlaceLabel({
      name,
      admin1: hit.admin1,
      country: hit.country,
      countryCode: hit.country_code,
    }),
    latitude: hit.latitude,
    longitude: hit.longitude,
  };
}

function fromPhoton(feature: PhotonFeature): GeoPlace | null {
  const props = feature.properties;
  const coords = feature.geometry?.coordinates;
  const name = (props?.name || props?.city || "").trim();
  if (!name || !coords || coords.length < 2) return null;
  const osmValue = (props?.osm_value || props?.type || "").toLowerCase();
  if (SKIP_OSM_VALUES.has(osmValue)) return null;
  const longitude = coords[0];
  const latitude = coords[1];
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    id: placeId(
      "ph",
      String(props?.osm_id ?? `${name}:${latitude}:${longitude}`),
    ),
    city: name,
    label: formatPlaceLabel({
      name,
      admin1: props?.state,
      country: props?.country,
      countryCode: props?.countrycode,
    }),
    latitude,
    longitude,
  };
}

function dedupe(places: GeoPlace[]) {
  const seen = new Set<string>();
  const next: GeoPlace[] = [];
  for (const place of places) {
    const key = place.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(place);
  }
  return next;
}

async function searchOpenMeteo(query: string): Promise<GeoPlace[]> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "8");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  const response = await fetch(url, {
    headers: headers(),
    next: { revalidate: 86_400 },
  });
  if (!response.ok) throw new Error(`Open-Meteo search failed (${response.status})`);
  const body = (await response.json()) as { results?: OpenMeteoHit[] };
  return (body.results ?? []).map(fromOpenMeteo).filter((place): place is GeoPlace => Boolean(place));
}

async function searchPhoton(query: string): Promise<GeoPlace[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "8");
  url.searchParams.set("lang", "en");
  url.searchParams.set("layer", "city");
  const response = await fetch(url, {
    headers: headers(),
    next: { revalidate: 86_400 },
  });
  if (!response.ok) throw new Error(`Photon search failed (${response.status})`);
  const body = (await response.json()) as { features?: PhotonFeature[] };
  return (body.features ?? [])
    .map(fromPhoton)
    .filter((place): place is GeoPlace => Boolean(place));
}

export async function searchPlaces(query: string): Promise<GeoPlace[]> {
  const q = query.trim().slice(0, 80);
  if (q.length < 2) return [];

  const settled = await Promise.allSettled([searchPhoton(q), searchOpenMeteo(q)]);
  const photon = settled[0].status === "fulfilled" ? settled[0].value : [];
  const openMeteo = settled[1].status === "fulfilled" ? settled[1].value : [];
  return dedupe([...photon, ...openMeteo]).slice(0, 8);
}

type NominatimAddress = {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  hamlet?: string;
  county?: string;
  state?: string;
  country?: string;
  country_code?: string;
};

async function reverseNominatim(
  latitude: number,
  longitude: number,
): Promise<GeoPlace | null> {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("zoom", "10");
  url.searchParams.set("accept-language", "en");
  const response = await fetch(url, {
    headers: headers(),
    next: { revalidate: 86_400 },
  });
  if (!response.ok) throw new Error(`Nominatim reverse failed (${response.status})`);
  const body = (await response.json()) as {
    address?: NominatimAddress;
    lat?: string;
    lon?: string;
  };
  const address = body.address;
  const name = (
    address?.city ||
    address?.town ||
    address?.village ||
    address?.municipality ||
    address?.hamlet ||
    address?.county ||
    ""
  ).trim();
  if (!name) return null;
  return {
    id: placeId("nm", `${latitude}:${longitude}`),
    city: name,
    label: formatPlaceLabel({
      name,
      admin1: address?.state,
      country: address?.country,
      countryCode: address?.country_code,
    }),
    latitude: Number(body.lat ?? latitude),
    longitude: Number(body.lon ?? longitude),
  };
}

async function reversePhoton(
  latitude: number,
  longitude: number,
): Promise<GeoPlace | null> {
  const url = new URL("https://photon.komoot.io/reverse");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("lang", "en");
  const response = await fetch(url, {
    headers: headers(),
    next: { revalidate: 86_400 },
  });
  if (!response.ok) throw new Error(`Photon reverse failed (${response.status})`);
  const body = (await response.json()) as { features?: PhotonFeature[] };
  const feature = body.features?.[0];
  if (!feature) return null;
  const props = feature.properties;
  const name = (props?.city || props?.name || "").trim();
  if (!name) return null;
  const coords = feature.geometry?.coordinates;
  return {
    id: placeId("ph-rev", `${latitude}:${longitude}`),
    city: name,
    label: formatPlaceLabel({
      name,
      admin1: props?.state,
      country: props?.country,
      countryCode: props?.countrycode,
    }),
    latitude: coords?.[1] ?? latitude,
    longitude: coords?.[0] ?? longitude,
  };
}

export async function reverseGeocode(
  latitude: number,
  longitude: number,
): Promise<GeoPlace | null> {
  try {
    const nominatim = await reverseNominatim(latitude, longitude);
    if (nominatim) return nominatim;
  } catch {
    // Fall through to Photon.
  }
  try {
    return await reversePhoton(latitude, longitude);
  } catch {
    return null;
  }
}
