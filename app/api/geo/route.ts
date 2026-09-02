import { reverseGeocode, searchPlaces } from "@/lib/geo/lookup";

export const runtime = "nodejs";

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function parseCoord(value: string | null) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const latitude = parseCoord(url.searchParams.get("lat"));
  const longitude = parseCoord(url.searchParams.get("lon"));

  try {
    if (query) {
      if (query.length < 2) return json({ places: [] });
      const places = await searchPlaces(query);
      return json({ places });
    }

    if (latitude != null && longitude != null) {
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return json({ error: "Those coordinates are not valid." }, 400);
      }
      const place = await reverseGeocode(latitude, longitude);
      if (!place) {
        return json({ error: "We could not find a city for that location." }, 404);
      }
      return json({ place });
    }

    return json({ error: "A search query or coordinates are required." }, 400);
  } catch {
    return json({ error: "Location lookup is unavailable right now." }, 502);
  }
}
