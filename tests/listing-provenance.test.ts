import { describe, expect, it } from "vitest";

import {
  isListingRequestable,
  listingProvenanceLabel,
} from "../lib/listings/provenance";

const now = Date.parse("2026-08-30T12:00:00.000Z");

describe("listing provenance", () => {
  it("keeps demos and unknown legacy rows view-only", () => {
    expect(
      isListingRequestable(
        {
          owner: { is_demo: true },
          provenance_status: "owner_attested",
          availability_confirmed_at: "2026-08-30T11:00:00.000Z",
        },
        now,
      ),
    ).toBe(false);
    const unknown = {
      owner: { is_demo: false },
      provenance_status: "unverified" as const,
      availability_confirmed_at: null,
    };
    expect(isListingRequestable(unknown, now)).toBe(false);
    expect(listingProvenanceLabel(unknown)).toMatch(/Unverified source/);
  });

  it("allows a recent owner attestation but expires stale availability", () => {
    const listing = {
      owner: { is_demo: false },
      provenance_status: "owner_attested" as const,
      availability_confirmed_at: "2026-08-29T12:00:00.000Z",
    };
    expect(isListingRequestable(listing, now)).toBe(true);
    expect(
      isListingRequestable(
        { ...listing, availability_confirmed_at: "2026-05-01T12:00:00.000Z" },
        now,
      ),
    ).toBe(false);
  });
});
