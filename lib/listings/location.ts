/**
 * Location matching for marketplace discovery.
 *
 * This intentionally works on the public city/area label only. It does not
 * geocode a visitor or compare exact coordinates, so a location search never
 * exposes a member's private street address or quietly requests device GPS.
 */
export function normalizeLocation(value: string) {
  return value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US");
}

/**
 * Higher scores are stronger matches. A city-only search such as "Marfa"
 * matches "Marfa, TX" as an exact city, while a state or neighbourhood
 * fragment remains a weaker but still useful match.
 */
export function locationMatchScore(location: string, query: string) {
  const normalizedLocation = normalizeLocation(location);
  const normalizedQuery = normalizeLocation(query);
  if (!normalizedLocation || !normalizedQuery) return 0;
  if (normalizedLocation === normalizedQuery) return 4;

  const city = normalizedLocation.split(",", 1)[0]?.trim() ?? "";
  const queryCity = normalizedQuery.split(",", 1)[0]?.trim() ?? "";
  if (city && city === queryCity) return 3;
  if (city && queryCity && city.startsWith(queryCity)) return 2.5;
  if (normalizedLocation.startsWith(normalizedQuery)) return 2;
  return normalizedLocation.includes(normalizedQuery) ? 1 : 0;
}

export function compareLocations(left: string, right: string, locale: string) {
  return new Intl.Collator(locale, { sensitivity: "base", numeric: true }).compare(
    left,
    right,
  );
}
