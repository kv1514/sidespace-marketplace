import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site-metadata";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Auth callbacks carry one-time codes and have nothing to index.
      // /preview is a candidate design, not the product. Keep it out of
      // search so a proposal never outranks the real homepage.
      disallow: ["/auth/", "/dashboard", "/preview"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
