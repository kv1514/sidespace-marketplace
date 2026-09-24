/**
 * Whether a listing shows a photo of the thing it is selling.
 *
 * One file because two very different places need the same answer. The grid
 * needs it to draw a cover; the ranking needs it because the cover is the first
 * and sometimes only thing a business reads off a card, and a card with no real
 * photo tells them the space was never worth photographing.
 *
 * Two ways a listing ends up without one, and the second is the interesting
 * one:
 *
 * 1. **No image at all**, so the grid falls back to the seeded stock frame - a
 *    photo of somebody else's market stall, presented as this listing.
 * 2. **The owner's profile picture as the cover.** Three live listings do this.
 *    One is a 96-pixel Google account avatar: a letter on a coloured circle,
 *    blown up to fill a card, which is where the grid's single worst-looking
 *    card came from. Nothing is broken and nothing is missing, so no
 *    completeness check caught it - the listing has an image_url, it is just a
 *    picture of the seller rather than of the wall.
 *
 * Comparing the cover to `owner.avatar_url` catches that exactly, without
 * guessing from dimensions or hosts, and without a network request. A seller
 * who genuinely wants their face on the card can upload the same photo as a
 * listing image; what this penalises is the default, not the choice.
 */
export const STOCK_LISTING_COVER = "/photos/market-creator.jpg";

export type CoverListing = {
  image_url?: string | null;
  image_urls?: string[] | null;
  owner?: { avatar_url?: string | null } | null;
};

/** Every image on the listing, preferring the gallery over the single column. */
export function coverCandidates(listing: CoverListing) {
  const gallery = Array.isArray(listing.image_urls) ? listing.image_urls : [];
  const urls = gallery.length
    ? gallery
    : typeof listing.image_url === "string"
      ? [listing.image_url]
      : [];
  return urls.filter((url): url is string => typeof url === "string" && url.length > 0);
}

/**
 * True when at least one image is a photo of the listing itself: not the seeded
 * stock frame, and not the owner's profile picture.
 *
 * The seed still sitting in older rows is read as "no photo" rather than
 * migrated away, the same way `listingPhotos` reads it: no row has to be
 * rewritten, and an owner who uploads later simply replaces it.
 */
export function hasOwnCover(listing: CoverListing) {
  const avatar = listing.owner?.avatar_url;
  return coverCandidates(listing).some(
    (url) => url !== STOCK_LISTING_COVER && !(typeof avatar === "string" && avatar && url === avatar),
  );
}
