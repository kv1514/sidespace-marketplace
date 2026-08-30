import { describe, expect, it } from "vitest";

import { requireStripeHostedUrl } from "../lib/stripe/urls";

describe("Stripe hosted redirect allowlist", () => {
  it("accepts the exact HTTPS Stripe host", () => {
    expect(
      requireStripeHostedUrl(
        "https://checkout.stripe.com/c/pay/cs_test_123",
        ["checkout.stripe.com"],
      ),
    ).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
  });

  it.each([
    "http://checkout.stripe.com/c/pay/cs_test_123",
    "https://checkout.stripe.com.evil.example/cs_test_123",
    "https://evil.example/?next=checkout.stripe.com",
  ])("rejects a non-Stripe redirect: %s", (url) => {
    expect(() =>
      requireStripeHostedUrl(url, ["checkout.stripe.com"]),
    ).toThrow(/unexpected hosted URL/);
  });
});
