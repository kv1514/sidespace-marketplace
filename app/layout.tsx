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
      <body>{children}</body>
    </html>
  );
}
