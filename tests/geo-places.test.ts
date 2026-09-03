import { describe, expect, it } from "vitest";

import {
  formatPlaceLabel,
  isPopulatedPlace,
  isUnitedStatesCountryCode,
  isUnitedStatesPlaceLabel,
} from "../lib/geo/places";

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

  it("rejects non-U.S. labels", () => {
    expect(
      formatPlaceLabel({
        name: "Toronto",
        admin1: "Ontario",
        country: "Canada",
        countryCode: "CA",
      }),
    ).toBe("");
  });

  it("accepts U.S. country codes case-insensitively", () => {
    expect(isUnitedStatesCountryCode("us")).toBe(true);
    expect(isUnitedStatesCountryCode("CA")).toBe(false);
    expect(isUnitedStatesCountryCode(undefined)).toBe(false);
  });

  it("requires a U.S. state in a manually entered place label", () => {
    expect(isUnitedStatesPlaceLabel("Brea, CA")).toBe(true);
    expect(isUnitedStatesPlaceLabel("Brea, California")).toBe(true);
    expect(isUnitedStatesPlaceLabel("Paris, France")).toBe(false);
    expect(isUnitedStatesPlaceLabel("Brea")).toBe(false);
  });
});

describe("isPopulatedPlace", () => {
  it("keeps cities and drops states", () => {
    expect(isPopulatedPlace("PPLA")).toBe(true);
    expect(isPopulatedPlace("ADM1")).toBe(false);
  });
});
