import { afterEach, describe, expect, it } from "vitest";

import { getAppOrigin } from "../lib/payments/checkout";
import { requireSameOrigin, requireUuid } from "../lib/payments/request";

describe("payment request trust boundary", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalNodeEnv = process.env.NODE_ENV;
  const mutableEnv = process.env as Record<string, string | undefined>;

  afterEach(() => {
    if (originalAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
    if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = originalNodeEnv;
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

  it("rejects a localhost Checkout origin in production", () => {
    mutableEnv.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    expect(() => getAppOrigin("http://localhost:3000/api/stripe/checkout")).toThrow(
      /must use HTTPS/,
    );
  });

  it("rejects HTTP payment actions in production even with a matching origin", () => {
    mutableEnv.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_APP_URL = "http://sidespace.example";
    expect(() =>
      requireSameOrigin(
        new Request("http://sidespace.example/api/payments/action", {
          method: "POST",
          headers: { origin: "http://sidespace.example" },
        }),
      ),
    ).toThrow(/require HTTPS/);
  });
});
