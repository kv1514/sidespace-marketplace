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
