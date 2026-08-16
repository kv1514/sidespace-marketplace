import type { MetadataRoute } from "next";

const SITE = "https://sidespace-marketplace.vercel.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Auth callbacks carry one-time codes and have nothing to index.
      disallow: ["/auth/"],
    },
    sitemap: `${SITE}/sitemap.xml`,
  };
}
