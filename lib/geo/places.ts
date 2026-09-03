export type GeoPlace = {
  id: string;
  label: string;
  city: string;
  latitude: number;
  longitude: number;
  countryCode: "US";
};

const US_STATES: Record<string, string> = {
  Alabama: "AL",
  Alaska: "AK",
  Arizona: "AZ",
  Arkansas: "AR",
  California: "CA",
  Colorado: "CO",
  Connecticut: "CT",
  Delaware: "DE",
  Florida: "FL",
  Georgia: "GA",
  Hawaii: "HI",
  Idaho: "ID",
  Illinois: "IL",
  Indiana: "IN",
  Iowa: "IA",
  Kansas: "KS",
  Kentucky: "KY",
  Louisiana: "LA",
  Maine: "ME",
  Maryland: "MD",
  "Massachusetts": "MA",
  Michigan: "MI",
  Minnesota: "MN",
  Mississippi: "MS",
  Missouri: "MO",
  Montana: "MT",
  Nebraska: "NE",
  Nevada: "NV",
  "New Hampshire": "NH",
  "New Jersey": "NJ",
  "New Mexico": "NM",
  "New York": "NY",
  "North Carolina": "NC",
  "North Dakota": "ND",
  Ohio: "OH",
  Oklahoma: "OK",
  Oregon: "OR",
  Pennsylvania: "PA",
  "Rhode Island": "RI",
  "South Carolina": "SC",
  "South Dakota": "SD",
  Tennessee: "TN",
  Texas: "TX",
  Utah: "UT",
  Vermont: "VT",
  Virginia: "VA",
  Washington: "WA",
  "West Virginia": "WV",
  Wisconsin: "WI",
  Wyoming: "WY",
  "District of Columbia": "DC",
  "Washington, D.C.": "DC",
  "Washington DC": "DC",
};

const US_STATE_CODES = new Set(Object.values(US_STATES));
const US_STATE_NAMES = new Set(
  Object.keys(US_STATES).map((name) => name.replace(/\./g, "").toLowerCase()),
);

export function isUnitedStatesCountryCode(value: unknown) {
  return typeof value === "string" && value.trim().toUpperCase() === "US";
}

function regionCode(admin1: string | undefined) {
  if (!admin1) return "";
  return US_STATES[admin1] ?? admin1;
}

/**
 * Free-text fallback guard for the profile city field. Autocomplete and GPS
 * are the preferred paths, but a member can still type a city when a lookup
 * is unavailable. Requiring a U.S. state prevents "Paris, France" (or a bare
 * city with no country context) from becoming new profile location data.
 */
export function isUnitedStatesPlaceLabel(value: string) {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return false;
  const city = parts.slice(0, -1).join(",").trim();
  const region = parts.at(-1)?.replace(/\./g, "").trim() ?? "";
  return (
    Boolean(city) &&
    (US_STATE_CODES.has(region.toUpperCase()) ||
      US_STATE_NAMES.has(region.toLowerCase()))
  );
}

/**
 * Public profile label: "Brea, CA". Buyers filter on this string, so keep it
 * short and familiar. Non-U.S. provider results are intentionally rejected.
 */
export function formatPlaceLabel(input: {
  name: string;
  admin1?: string;
  country?: string;
  countryCode?: string;
}) {
  const name = input.name.trim();
  if (!name) return "";
  if (!isUnitedStatesCountryCode(input.countryCode)) return "";
  const region = regionCode(input.admin1?.trim());
  return region && region !== name ? `${name}, ${region}` : name;
}

export function isPopulatedPlace(featureCode: string | undefined) {
  if (!featureCode) return true;
  return featureCode.startsWith("PPL") || featureCode === "STLMT";
}
