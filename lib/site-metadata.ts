import type { Metadata } from "next";

/** Canonical public origin. Used for metadata, sitemap, and robots. */
export const SITE_URL = "https://sidespace.ad";

/**
 * The default image for link previews that do not point at a listing.
 *
 * Next does not deep-merge `openGraph`: a page that declares its own
 * `openGraph` block replaces the layout's entirely, `images` included. Every
 * page on this site declares one, so the site shipped with no `og:image` at
 * all - and a scraper with no image to use picks one off the page instead. On
 * the homepage the first thing it found was a member's avatar, so sharing
 * SideSpace anywhere put a stranger's face on the card.
 *
 * `twitter` behaves the same way, which is why the two legal pages that
 * declare a `twitter` block need it too. The tell, before this was traced, was
 * that the homepage emitted `twitter:image` and no `og:image` - the layout's
 * twitter block survived because no page had overridden it.
 *
 * Importing one constant everywhere is what stops this coming back: the value
 * lives in a single place, and a new page that forgets it is a visible
 * omission next to eight that have it rather than a silent regression nobody
 * notices until a link looks wrong in someone's DMs.
 */
export const OG_IMAGE: NonNullable<
  NonNullable<Metadata["openGraph"]>["images"]
> = [
  {
    url: "/og-sidespace.png",
    width: 2400,
    height: 1260,
    alt: "SideSpace - local attention, now bookable",
  },
];

export type ListingSocialPreview = {
  id: string;
  title: string;
  channel?: string | null;
  format?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  imageUrls?: readonly string[] | null;
  locationArea?: string | null;
  ownerName?: string | null;
  ownerCity?: string | null;
};

function metadataText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function truncateMetadata(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * The stock cover business briefs used to be seeded with.
 *
 * A brief is a wanted ad, usually written before there is anything to
 * photograph. Seeding it with this made every campaign share as a picture of
 * somebody else's market stall, so briefs no longer get it - and the ones
 * published before that stopped are read here as having no photo, rather than
 * having every old row rewritten. The generic SideSpace card takes over, which
 * is what a brief with no photo should share as.
 */
const SEEDED_BRIEF_COVER = "/photos/market-creator.jpg";

function metadataImageUrl(value: unknown) {
  const candidate = metadataText(value);
  if (!candidate) return null;

  try {
    const url = new URL(candidate, SITE_URL);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** Build share metadata for the listing URL used by marketplace cards. */
export function createListingSocialMetadata(
  listing: ListingSocialPreview,
): Metadata {
  const listingTitle =
    truncateMetadata(metadataText(listing.title), 100) || "SideSpace listing";
  const ownerName = truncateMetadata(metadataText(listing.ownerName), 60);
  const socialTitle = truncateMetadata(
    ownerName ? `${listingTitle} by ${ownerName}` : listingTitle,
    140,
  );
  const location = metadataText(listing.locationArea || listing.ownerCity);
  const context = [
    metadataText(listing.channel),
    metadataText(listing.format),
    location,
  ]
    .filter(Boolean)
    .join(" · ");
  const description = truncateMetadata(
    [metadataText(listing.description), context].filter(Boolean).join(" · ") ||
      "Local advertising inventory listed on SideSpace.",
    220,
  );
  const listingUrl = new URL(
    `/marketplace?listing=${encodeURIComponent(listing.id)}`,
    SITE_URL,
  ).toString();
  const isBrief = metadataText(listing.channel) === "Business brief";
  const imageUrl = [listing.imageUrl, ...(listing.imageUrls ?? [])]
    .filter((value) => !(isBrief && metadataText(value) === SEEDED_BRIEF_COVER))
    .map(metadataImageUrl)
    .find((value): value is string => Boolean(value));
  const images = imageUrl
    ? [{ url: imageUrl, alt: `${listingTitle} on SideSpace` }]
    : OG_IMAGE;

  return {
    alternates: { canonical: listingUrl },
    title: listingTitle,
    description,
    openGraph: {
      type: "website",
      siteName: "SideSpace",
      url: listingUrl,
      title: socialTitle,
      description,
      images,
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      images,
    },
  };
}
