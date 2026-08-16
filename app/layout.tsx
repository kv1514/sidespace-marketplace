import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://sidespace-marketplace.vercel.app"),
  title: {
    default: "SideSpace - Affordable local reach",
    template: "%s · SideSpace",
  },
  description:
    "Book rural creators, farm stands, cafe counters, Main Street windows, and other local ad spots from $8.",
  openGraph: {
    title: "SideSpace - Local reach from $8",
    description:
      "Affordable small-town placements for small businesses, with no broker and no minimum spend.",
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
      <body>{children}</body>
    </html>
  );
}
