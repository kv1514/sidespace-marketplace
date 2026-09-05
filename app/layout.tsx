import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import "lenis/dist/lenis.css";
import "./public-site.css";
import { OG_IMAGE, SITE_URL } from "@/lib/site-metadata";
import LocaleProvider from "@/app/components/LocaleProvider";
import {
  LOCALE_COOKIE,
  LISTING_TRANSLATION_COOKIE,
  localeFromAcceptLanguage,
  localeTag,
  parseLocale,
} from "@/lib/i18n";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fbf7e6",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // Without this, no page emits rel=canonical and the legal pages have no
  // identity of their own for crawlers to separate from the homepage.
  alternates: { canonical: "/" },
  verification: {
    google: "-tVSDszKSbYFpt-rw-F18V4FtwnhWrxmSrjOFy4ZRns",
  },
  title: {
    default: "SideSpace - Local attention, now bookable",
    template: "%s · SideSpace",
  },
  description:
    "Book creator listings for social audiences, storefront windows, vehicles, counters, and community boards. Free to join, and the creator sets the price.",
  openGraph: {
    type: "website",
    siteName: "SideSpace",
    url: SITE_URL,
    title: "SideSpace - Local attention, now bookable",
    description:
      "Book creators offering social, physical, and sponsorship inventory—or list the way you can advertise.",
    images: OG_IMAGE,
  },
  twitter: {
    card: "summary_large_image",
    title: "SideSpace - Local attention, now bookable",
    description:
      "Book creator-led social audiences, physical placements, and sponsorships—or list the way you can advertise.",
    images: OG_IMAGE,
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/logo.png", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png" }],
  },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const requestCookies = await cookies();
  const requestHeaders = await headers();
  const initialLocale =
    parseLocale(requestCookies.get(LOCALE_COOKIE)?.value) ??
    localeFromAcceptLanguage(requestHeaders.get("accept-language"));
  const initialTranslateListings =
    requestCookies.get(LISTING_TRANSLATION_COOKIE)?.value !== "0";

  return (
    <html lang={localeTag(initialLocale)}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@6..144,400..800&family=Google+Sans+Code:wght@400..700&family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <LocaleProvider
          initialLocale={initialLocale}
          initialTranslateListings={initialTranslateListings}
        >
          {children}
        </LocaleProvider>
        <Analytics />
      </body>
    </html>
  );
}
