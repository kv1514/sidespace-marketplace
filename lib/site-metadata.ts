import type { Metadata } from "next";

/** Canonical public origin. Used for metadata, sitemap, and robots. */
export const SITE_URL = "https://sidespace.ad";

/**
 * The image every link preview uses.
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
