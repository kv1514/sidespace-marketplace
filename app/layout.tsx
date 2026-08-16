import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://sidespace-marketplace.vercel.app"),
  title: {
    default: "SideSpace - Affordable local advertising space",
    template: "%s · SideSpace",
  },
  description:
    "Book local creators, storefront windows, vehicles, counters, and community boards. Free to join, and listings start at $2.",
  openGraph: {
    type: "website",
    siteName: "SideSpace",
    url: "https://sidespace-marketplace.vercel.app",
    title: "SideSpace - Get seen where it matters",
    description:
      "A marketplace for everyday advertising space: local creators, storefront windows, vehicles, and community boards. Free to join, no broker, no minimum spend.",
    images: ["/og-local.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "SideSpace - Get seen where it matters",
    description:
      "Book local creators and real-world ad space. Free to join, listings start at $2.",
    images: ["/og-local.png"],
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
          href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@6..144,400..800&family=Google+Sans+Code:wght@400..700&family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
