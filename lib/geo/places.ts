export type GeoPlace = {
  id: string;
  label: string;
  city: string;
  latitude: number;
  longitude: number;
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

const CA_PROVINCES: Record<string, string> = {
  Alberta: "AB",
  "British Columbia": "BC",
  Manitoba: "MB",
  "New Brunswick": "NB",
  "Newfoundland and Labrador": "NL",
  "Northwest Territories": "NT",
  "Nova Scotia": "NS",
  Nunavut: "NU",
  Ontario: "ON",
  "Prince Edward Island": "PE",
  Quebec: "QC",
  Québec: "QC",
  Saskatchewan: "SK",
  Yukon: "YT",
};

function regionCode(countryCode: string, admin1: string | undefined) {
  if (!admin1) return "";
  const code = countryCode.toUpperCase();
  if (code === "US") return US_STATES[admin1] ?? admin1;
  if (code === "CA") return CA_PROVINCES[admin1] ?? admin1;
  return admin1;
}

/**
 * Public profile label: "Brea, CA", "Toronto, ON", "Paris, France".
 * Buyers filter on this string, so keep it short and familiar.
 */
export function formatPlaceLabel(input: {
  name: string;
  admin1?: string;
  country?: string;
  countryCode?: string;
}) {
  const name = input.name.trim();
  if (!name) return "";
  const countryCode = (input.countryCode ?? "").toUpperCase();
  const country = (input.country ?? "").trim();
  const region = regionCode(countryCode, input.admin1?.trim());

  if (countryCode === "US" || countryCode === "CA") {
    return region && region !== name ? `${name}, ${region}` : name;
  }
  if (country && country !== name) {
    return `${name}, ${country}`;
  }
  return name;
}

export function isPopulatedPlace(featureCode: string | undefined) {
  if (!featureCode) return true;
  return featureCode.startsWith("PPL") || featureCode === "STLMT";
}
