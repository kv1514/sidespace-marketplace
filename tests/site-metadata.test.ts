import { describe, expect, it } from "vitest";

import {
  createListingSocialMetadata,
  OG_IMAGE,
} from "../lib/site-metadata";

const listingId = "a1111111-1111-4111-8111-111111111111";

describe("listing social metadata", () => {
  it("uses the listing identity, URL, and image for shared links", () => {
    const metadata = createListingSocialMetadata({
      id: listingId,
      title: "Local story + saved highlight",
      channel: "Instagram",
      format: "3 frames - 48 hr highlight",
      description: "A natural recommendation for a local shop.",
      imageUrl: "/photos/market-creator.jpg",
      locationArea: "Bisbee, AZ",
      ownerName: "Maya Alvarez",
    });

    expect(metadata.title).toBe("Local story + saved highlight");
    expect(metadata.alternates?.canonical).toBe(
      `https://sidespace.ad/marketplace?listing=${listingId}`,
    );
    expect(metadata.openGraph).toMatchObject({
      title: "Local story + saved highlight by Maya Alvarez",
      url: `https://sidespace.ad/marketplace?listing=${listingId}`,
      images: [
        {
          url: "https://sidespace.ad/photos/market-creator.jpg",
          alt: "Local story + saved highlight on SideSpace",
        },
      ],
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      images: [
        {
          url: "https://sidespace.ad/photos/market-creator.jpg",
          alt: "Local story + saved highlight on SideSpace",
        },
      ],
    });
  });

  it("does not share a business brief as the stock cover it was seeded with", () => {
    // Briefs are wanted ads, written before there is anything to photograph.
    // Publishing used to seed them with this file, so every campaign shared as
    // a photo of somebody else's market stall. Old rows still carry it.
    const metadata = createListingSocialMetadata({
      id: listingId,
      title: "Looking for a window in Fullerton",
      channel: "Business brief",
      imageUrl: "/photos/market-creator.jpg",
      imageUrls: ["/photos/market-creator.jpg"],
    });

    expect(metadata.openGraph).toMatchObject({ images: OG_IMAGE });
    expect(metadata.twitter).toMatchObject({ images: OG_IMAGE });
  });

  it("still shares a photo the business actually uploaded to its brief", () => {
    const metadata = createListingSocialMetadata({
      id: listingId,
      title: "Looking for a window in Fullerton",
      channel: "Business brief",
      imageUrl: "/photos/small-town-coffee.jpg",
    });

    expect(metadata.openGraph).toMatchObject({
      images: [
        {
          url: "https://sidespace.ad/photos/small-town-coffee.jpg",
          alt: "Looking for a window in Fullerton on SideSpace",
        },
      ],
    });
  });

  it("keeps the branded fallback when listing images are not usable URLs", () => {
    const metadata = createListingSocialMetadata({
      id: listingId,
      title: "A listing without a shareable photo",
      imageUrl: "javascript:alert(1)",
      imageUrls: ["data:image/png;base64,not-a-real-image"],
    });

    expect(metadata.openGraph).toMatchObject({ images: OG_IMAGE });
    expect(metadata.twitter).toMatchObject({ images: OG_IMAGE });
  });
});

// A listing published without a photo has image_url seeded from the member's
// avatar. Sharing it put the seller's Google account photo in the preview card
// - the exact thing the branded card exists to prevent - and it was still
// happening on a live listing published after the site-wide fix landed.
describe("a listing image that is really a member's face", () => {
  const base = {
    id: "listing-1",
    title: "Instagram post or story on my account, Berkeley",
    ownerName: "Bruce",
    channel: "Instagram",
    format: "one post",
    description: "A post to my followers.",
    locationArea: "Berkeley",
    ownerCity: "Berkeley",
    imageUrls: [] as string[],
  };
  const ogOf = (meta: ReturnType<typeof createListingSocialMetadata>) => {
    const images = meta.openGraph?.images;
    const first = Array.isArray(images) ? images[0] : images;
    return typeof first === "string" ? first : (first as { url: string })?.url;
  };

  it.each([
    ["a Google account photo", "https://lh3.googleusercontent.com/a/ACg8ocITSvR6=s96-c"],
    ["a googleusercontent subdomain", "https://lh5.googleusercontent.com/a/xyz=s96-c"],
    ["an uploaded avatar in storage", "https://x.supabase.co/storage/v1/object/public/marketplace-media/uid/profiles/a.jpg"],
  ])("falls back to the branded card for %s", (_label, avatar) => {
    const og = ogOf(createListingSocialMetadata({ ...base, imageUrl: avatar }));
    expect(og).not.toContain("googleusercontent");
    expect(og).not.toContain("/profiles/");
    expect(og).toContain("og-sidespace.png");
  });

  it("still uses a real listing photo", () => {
    const photo =
      "https://x.supabase.co/storage/v1/object/public/marketplace-media/uid/listings/9a241a80.jpg";
    expect(ogOf(createListingSocialMetadata({ ...base, imageUrl: photo }))).toBe(photo);
  });

  it("skips an avatar and takes the next real photo", () => {
    const photo =
      "https://x.supabase.co/storage/v1/object/public/marketplace-media/uid/listings/real.jpg";
    const og = ogOf(
      createListingSocialMetadata({
        ...base,
        imageUrl: "https://lh3.googleusercontent.com/a/avatar=s96-c",
        imageUrls: [photo],
      }),
    );
    expect(og).toBe(photo);
  });
});
