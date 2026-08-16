import type { MetadataRoute } from "next";

const SITE = "https://sidespace-marketplace.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
  ];
}
