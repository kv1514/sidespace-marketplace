import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import "lenis/dist/lenis.css";
import "./public-site.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://sidespace-marketplace.vercel.app"),
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
    "Book local creators, storefront windows, vehicles, counters, and community boards. Free to join, and the owner sets the price.",
  openGraph: {
    type: "website",
    siteName: "SideSpace",
    url: "https://sidespace-marketplace.vercel.app",
    title: "SideSpace - Local attention, now bookable",
    description:
      "Book local creators, storefronts, vehicles, newsletters, and sponsorship opportunities—or list the attention you already own.",
    images: ["/og-card.jpg"],
  },
  twitter: {
    card: "summary_large_image",
    title: "SideSpace - Local attention, now bookable",
    description:
      "Book creators and real-world local ad space—or list the attention you already own.",
    images: ["/og-card.jpg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
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
        {children}
        <Analytics />
      </body>
    </html>
  );
}
