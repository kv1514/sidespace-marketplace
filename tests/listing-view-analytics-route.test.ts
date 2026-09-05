import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCookie: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: mocks.getCookie }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mocks.rpc }),
}));

import { POST } from "@/app/api/analytics/listing-view/route";

const listingId = "93000000-0000-4000-8000-000000000001";
const visitorId = "93000000-0000-4000-8000-000000000002";

function makeRequest(ip = "198.51.100.1") {
  return new Request("https://sidespace.ad/api/analytics/listing-view", {
    method: "POST",
    headers: {
      origin: "https://sidespace.ad",
      "content-type": "application/json",
      "x-real-ip": ip,
    },
    body: JSON.stringify({ listingId }),
  });
}

describe("listing-view analytics route", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://sidespace.ad";
    process.env.ANALYTICS_HASH_SECRET = "a".repeat(32);
    mocks.getCookie.mockReset();
    mocks.getCookie.mockReturnValue({ value: visitorId });
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({ data: true, error: null });
  });

  it("rejects cross-origin requests before using the admin client", async () => {
    const request = new Request(makeRequest(), {
      headers: {
        origin: "https://evil.example",
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("requires a small JSON request", async () => {
    const request = new Request(makeRequest(), {
      headers: {
        origin: "https://sidespace.ad",
        "content-type": "text/plain",
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(415);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("hashes the visitor cookie and sends only the listing UUID to the server RPC", async () => {
    const response = await POST(makeRequest("198.51.100.2"));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ recorded: true });
    expect(mocks.rpc).toHaveBeenCalledWith("record_listing_view", {
      target_listing_id: listingId,
      viewer_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("fails closed for a weak analytics secret", async () => {
    process.env.ANALYTICS_HASH_SECRET = "too-short";

    const response = await POST(makeRequest("198.51.100.3"));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ recorded: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("limits a single client before allowing an unbounded write flood", async () => {
    const ip = "198.51.100.4";

    for (let index = 0; index < 240; index += 1) {
      await POST(makeRequest(ip));
    }

    const response = await POST(makeRequest(ip));

    expect(response.status).toBe(429);
    expect(mocks.rpc).toHaveBeenCalledTimes(240);
  });
});
