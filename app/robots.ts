import type { MetadataRoute } from "next";

const SITE = "https://sidespace-marketplace.vercel.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Auth callbacks carry one-time codes and have nothing to index.
      // /preview is a candidate design, not the product. Keep it out of
      // search so a proposal never outranks the real homepage.
      disallow: ["/auth/", "/preview"],
    },
    sitemap: `${SITE}/sitemap.xml`,
  };
}
