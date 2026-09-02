import { describe, expect, it } from "vitest";

import { formatPlaceLabel, isPopulatedPlace } from "../lib/geo/places";

describe("formatPlaceLabel", () => {
  it("uses city and state abbreviation in the US", () => {
    expect(
      formatPlaceLabel({
        name: "Brea",
        admin1: "California",
        country: "United States",
        countryCode: "US",
      }),
    ).toBe("Brea, CA");
  });

  it("uses city and province abbreviation in Canada", () => {
    expect(
      formatPlaceLabel({
        name: "Toronto",
        admin1: "Ontario",
        country: "Canada",
        countryCode: "CA",
      }),
    ).toBe("Toronto, ON");
  });

  it("uses city and country elsewhere", () => {
    expect(
      formatPlaceLabel({
        name: "Paris",
        admin1: "Île-de-France",
        country: "France",
        countryCode: "FR",
      }),
    ).toBe("Paris, France");
  });
});

describe("isPopulatedPlace", () => {
  it("keeps cities and drops states", () => {
    expect(isPopulatedPlace("PPLA")).toBe(true);
    expect(isPopulatedPlace("ADM1")).toBe(false);
  });
});
