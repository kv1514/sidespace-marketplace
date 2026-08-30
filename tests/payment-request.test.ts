import { afterEach, describe, expect, it } from "vitest";

import { requireSameOrigin, requireUuid } from "../lib/payments/request";

describe("payment request trust boundary", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    if (originalAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
  });

  it("requires the exact configured browser origin", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://sidespace.example";
    expect(() =>
      requireSameOrigin(
        new Request("https://sidespace.example/api/stripe/checkout", {
          method: "POST",
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).toThrow(/did not come from SideSpace/);
    expect(() =>
      requireSameOrigin(
        new Request("https://sidespace.example/api/stripe/checkout", {
          method: "POST",
          headers: { origin: "https://sidespace.example" },
        }),
      ),
    ).not.toThrow();
  });

  it("accepts only canonical UUID campaign identifiers", () => {
    expect(
      requireUuid(
        "123e4567-e89b-42d3-a456-426614174000",
        "Invalid campaign.",
      ),
    ).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(() => requireUuid("campaign-1", "Invalid campaign.")).toThrow(
      /Invalid campaign/,
    );
  });
});
