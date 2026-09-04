import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

// The site answers on five hostnames and NEXT_PUBLIC_APP_URL names one, so
// every other host reaches checkout and gets 403 from requireSameOrigin. The
// redirect closes that. Two properties of the rule matter more than the
// redirect itself, and neither is obvious from reading it:
//
//   1. A `*.vercel.app` wildcard would bounce every preview deployment to
//      production and make review deploys untestable.
//   2. A rule covering /api would 308 Stripe webhooks and the Slack slash
//      command, neither of which follows redirects - deliveries would be
//      dropped silently, which is the failure mode nobody notices.
const CANONICAL = "https://sidespace.ad";

async function redirectRules() {
  const redirects = nextConfig.redirects;
  expect(typeof redirects).toBe("function");
  return (await redirects!.call(nextConfig)) as Array<{
    source: string;
    destination: string;
    permanent?: boolean;
    has?: Array<{ type: string; value: string }>;
  }>;
}

describe("canonical host redirect", () => {
  it("covers every non-canonical hostname that currently serves the site", async () => {
    const rules = await redirectRules();
    const hosts = rules.flatMap((rule) =>
      (rule.has ?? []).filter((h) => h.type === "host").map((h) => h.value),
    );
    expect(hosts).toContain("www.sidespace.ad");
    expect(hosts).toContain("sidespace-marketplace.vercel.app");
    expect(hosts).toContain("sidespace-marketplace-sidespace.vercel.app");
  });

  it("never sends the canonical host to itself", async () => {
    const rules = await redirectRules();
    const hosts = rules.flatMap((rule) =>
      (rule.has ?? []).filter((h) => h.type === "host").map((h) => h.value),
    );
    expect(hosts).not.toContain("sidespace.ad");
  });

  it("matches hosts exactly, so preview deployments are untouched", async () => {
    const rules = await redirectRules();
    for (const rule of rules) {
      const hostRules = (rule.has ?? []).filter((h) => h.type === "host");
      expect(hostRules.length).toBeGreaterThan(0);
      for (const { value } of hostRules) {
        // A wildcard, regex or named parameter here would catch previews.
        expect(value).not.toMatch(/[*(:)]/);
        expect(value).not.toBe("vercel.app");
        // Every preview URL Vercel generates carries a build-or-branch segment
        // before the team suffix. The one branch alias we do serve production
        // on is deliberately excluded so previewing main still works.
        expect(value).not.toContain("-git-");
      }
    }
  });

  it("leaves /api alone, because webhooks do not follow redirects", async () => {
    const rules = await redirectRules();
    for (const rule of rules) {
      expect(rule.source).toContain("(?!api/)");
    }
  });

  it("sends everything it does match to the canonical origin, permanently", async () => {
    const rules = await redirectRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.destination.startsWith(`${CANONICAL}/`)).toBe(true);
      expect(rule.permanent).toBe(true);
      // The path parameter has to reach the destination or every redirect
      // would dump visitors on the homepage.
      expect(rule.destination).toContain(":path");
    }
  });
});
