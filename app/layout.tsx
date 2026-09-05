import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import "lenis/dist/lenis.css";
import "./public-site.css";
import { OG_IMAGE, SITE_URL } from "@/lib/site-metadata";
import { LocaleProvider } from "@/lib/i18n/client";
import { loadDictionary } from "@/lib/i18n/dictionaries";
import { LOCALE_TAGS } from "@/lib/i18n/locales";
import { getLocale, getTranslator } from "@/lib/i18n/server";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fbf7e6",
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return {
  metadataBase: new URL(SITE_URL),
  // Without this, no page emits rel=canonical and the legal pages have no
  // identity of their own for crawlers to separate from the homepage.
  alternates: { canonical: "/" },
  verification: {
    google: "-tVSDszKSbYFpt-rw-F18V4FtwnhWrxmSrjOFy4ZRns",
  },
  title: {
    default: t("SideSpace - Local attention, now bookable"),
    template: "%s · SideSpace",
  },
  description: t(
    "Book creator listings for social audiences, storefront windows, vehicles, counters, and community boards. Free to join, and the creator sets the price.",
  ),
  openGraph: {
    type: "website",
    siteName: "SideSpace",
    url: SITE_URL,
    title: t("SideSpace - Local attention, now bookable"),
    description: t(
      "Book creators offering social, physical, and sponsorship inventory—or list the way you can advertise.",
    ),
    images: OG_IMAGE,
  },
  twitter: {
    card: "summary_large_image",
    title: t("SideSpace - Local attention, now bookable"),
    description: t(
      "Book creator-led social audiences, physical placements, and sponsorships—or list the way you can advertise.",
    ),
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
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The language is decided once per page load, here, and handed to every
  // client component through the provider. Reading the request makes every
  // route dynamic; the pages that matter already were.
  const locale = await getLocale();
  const dictionary = await loadDictionary(locale);
  return (
    <html lang={LOCALE_TAGS[locale]}>
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
        <LocaleProvider locale={locale} dictionary={dictionary}>
          {children}
        </LocaleProvider>
        <Analytics />
      </body>
    </html>
  );
}
