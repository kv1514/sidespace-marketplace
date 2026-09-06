import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import "lenis/dist/lenis.css";
import "./public-site.css";
import { OG_IMAGE, SITE_URL } from "@/lib/site-metadata";
import LocaleProvider from "@/app/components/LocaleProvider";
import { CURRENCY_COOKIE, currencyFromRequest } from "@/lib/currency";
import { getTranslator } from "@/lib/i18n-server";
import {
  LOCALE_COOKIE,
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

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return {
  metadataBase: new URL(SITE_URL),
  // Without this, no page emits rel=canonical and the legal pages have no
  // identity of their own for crawlers to separate from the homepage.
  alternates: { canonical: "/" },
  verification: {
    google: "-tVSDszKSbYFpt-rw-F18V4FtwnhWrxmSrjOFy4ZRns",
  },
  title: {
    default: t("meta.siteTitle"),
    template: "%s · SideSpace",
  },
  description: t("meta.siteDescription"),
  openGraph: {
    type: "website",
    siteName: "SideSpace",
    url: SITE_URL,
    title: t("meta.siteTitle"),
    description: t("meta.ogDescription"),
    images: OG_IMAGE,
  },
  twitter: {
    card: "summary_large_image",
    title: t("meta.siteTitle"),
    description: t("meta.twitterDescription"),
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
  const requestCookies = await cookies();
  const requestHeaders = await headers();
  const initialLocale =
    parseLocale(requestCookies.get(LOCALE_COOKIE)?.value) ??
    localeFromAcceptLanguage(requestHeaders.get("accept-language"));
  const initialCurrency = currencyFromRequest({
    cookie: requestCookies.get(CURRENCY_COOKIE)?.value,
    // These headers are supplied by the hosting edge. Do not use a browser
    // supplied country field: it would make automatic currency selection easy
    // to spoof and would be surprising when a saved currency exists.
    country:
      requestHeaders.get("x-vercel-ip-country") ??
      requestHeaders.get("cf-ipcountry") ??
      requestHeaders.get("x-country-code"),
    acceptLanguage: requestHeaders.get("accept-language"),
    locale: initialLocale,
  });

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
          initialCurrency={initialCurrency}
        >
          {children}
        </LocaleProvider>
        <Analytics />
      </body>
    </html>
  );
}
