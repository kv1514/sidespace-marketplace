import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
  /**
   * Send every non-canonical production hostname to sidespace.ad.
   *
   * The site answers on five hostnames, but NEXT_PUBLIC_APP_URL names exactly
   * one of them. `requireSameOrigin` compares the request Origin against that
   * value, so a visitor who lands on any of the others can browse and sign up
   * normally and then gets `403 This request did not come from SideSpace.` the
   * moment they try to pay. Nothing surfaces until checkout, which is the worst
   * possible place to find out.
   *
   *   sidespace.ad                             origin accepted
   *   www.sidespace.ad                         origin REJECTED  <- people type www
   *   sidespace-marketplace.vercel.app         origin REJECTED  <- pre-domain links
   *   sidespace-marketplace-sidespace...       origin REJECTED
   *
   * Redirecting the page routes means a browser is never on a non-canonical
   * origin long enough to submit anything, so the mismatch cannot be reached.
   *
   * TWO THINGS THIS DELIBERATELY DOES NOT DO
   *
   * It does not match `*.vercel.app`. Every preview deployment lives on that
   * suffix, so a wildcard would bounce every preview to production and make
   * review deploys untestable. Each host is matched exactly, and the
   * git-branch alias is left alone precisely so previewing main still works.
   *
   * It does not redirect `/api/*`. Stripe webhooks and the Slack slash command
   * POST to a URL configured elsewhere, and neither follows redirects - a 308
   * on those paths would silently drop webhook deliveries. Server-to-server
   * callers keep working on whichever hostname they were pointed at; only
   * browsers move.
   */
  async redirects() {
    const canonical = "https://sidespace.ad";
    const nonCanonicalHosts = [
      "www.sidespace.ad",
      "sidespace-marketplace.vercel.app",
      "sidespace-marketplace-sidespace.vercel.app",
    ];
    return nonCanonicalHosts.map((host) => ({
      source: "/:path((?!api/).*)",
      has: [{ type: "host", value: host }],
      destination: `${canonical}/:path`,
      permanent: true,
    }));
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The site has authenticated sessions, so it must not be framed.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=(self), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
