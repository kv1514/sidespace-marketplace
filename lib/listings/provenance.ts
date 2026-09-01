export type ListingProvenanceStatus =
  | "demo"
  | "unverified"
  | "owner_attested"
  | "staff_verified";

export type ListingProvenanceInput = {
  provenance_status?: ListingProvenanceStatus | null;
  availability_confirmed_at?: string | null;
  owner: { is_demo: boolean };
};

const CONFIRMATION_DAYS = 90;

export function listingProvenance(
  listing: ListingProvenanceInput,
): ListingProvenanceStatus {
  if (listing.owner.is_demo) return "demo";
  return listing.provenance_status ?? "unverified";
}

export function listingProvenanceLabel(listing: ListingProvenanceInput) {
  switch (listingProvenance(listing)) {
    case "demo":
      return "Demo — view only";
    case "staff_verified":
      return "Verified listing";
    case "owner_attested":
      return "Owner-published";
    default:
      return "Unverified source — view only";
  }
}

export function isListingRequestable(
  listing: ListingProvenanceInput,
  now = Date.now(),
) {
  const status = listingProvenance(listing);
  if (status !== "owner_attested" && status !== "staff_verified") return false;
  if (!listing.availability_confirmed_at) return false;
  const confirmedAt = Date.parse(listing.availability_confirmed_at);
  if (!Number.isFinite(confirmedAt)) return false;
  return now - confirmedAt <= CONFIRMATION_DAYS * 24 * 60 * 60 * 1000;
}

export function listingAvailabilityLabel(listing: ListingProvenanceInput) {
  if (listingProvenance(listing) === "demo") return "EXAMPLE";
  return isListingRequestable(listing) ? "OWNER CONFIRMED" : "VIEW ONLY";
}
