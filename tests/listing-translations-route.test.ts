import { beforeEach, describe, expect, it, vi } from "vitest";

import { listingSourceHash } from "../lib/listings/translate-server";

const mocks = vi.hoisted(() => ({
  publicResult: { data: [] as unknown[], error: null as unknown },
  cacheResult: { data: [] as unknown[], error: null as unknown },
  upsert: vi.fn(),
  fetch: vi.fn(),
}));

/** The bits of a Supabase query builder the route touches: chainable filters, awaitable. */
function queryBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "in", "eq"]) builder[name] = vi.fn(() => builder);
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

vi.mock("@/lib/supabase/public", () => ({
  createPublicClient: () => ({
    from: () => queryBuilder(mocks.publicResult),
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const builder = queryBuilder(mocks.cacheResult);
      builder.upsert = mocks.upsert;
      return builder;
    },
  }),
}));

import { POST } from "@/app/api/listings/translations/route";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const listingA = { id: A, title: "Cafe window", description: "By the door.", format: "" };
const listingB = { id: B, title: "Dorm door", description: "", deliverables: "A photo of the ad up." };

function makeRequest(body: unknown, origin = "https://sidespace.ad") {
  return new Request("https://sidespace.ad/api/listings/translations", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function modelAnswer(listings: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ listings }) }],
    }),
  };
}

describe("the listing translations route", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.GEMINI_API_KEY;
    mocks.publicResult = { data: [], error: null };
    mocks.cacheResult = { data: [], error: null };
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue({ error: null });
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("answers a cross-origin caller with nothing and never calls the model", async () => {
    const response = await POST(makeRequest({ locale: "es", listingIds: [A] }, "https://evil.example"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ translations: {} });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("has nothing to translate into English or into a language it does not speak", async () => {
    expect((await POST(makeRequest({ locale: "en", listingIds: [A] }))).status).toBe(400);
    expect((await POST(makeRequest({ locale: "tlh", listingIds: [A] }))).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("serves a fresh cached translation without calling the model", async () => {
    mocks.publicResult = { data: [listingA], error: null };
    mocks.cacheResult = {
      data: [{ listing_id: A, source_hash: listingSourceHash(listingA), fields: { title: "Ventana" } }],
      error: null,
    };
    const response = await POST(makeRequest({ locale: "es", listingIds: [A, "not-a-uuid"] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ translations: { [A]: { title: "Ventana" } } });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("translates what the cache lacks, caches it with the listing's digest, and returns both", async () => {
    mocks.publicResult = { data: [listingA, listingB], error: null };
    mocks.cacheResult = {
      data: [{ listing_id: A, source_hash: listingSourceHash(listingA), fields: { title: "Ventana" } }],
      error: null,
    };
    mocks.fetch.mockResolvedValue(
      modelAnswer([
        {
          id: B,
          title: "Puerta de residencia",
          description: "invented: the owner wrote nothing here",
          deliverables: "Una foto del anuncio colocado.",
          format: "",
        },
      ]),
    );

    const response = await POST(makeRequest({ locale: "es", listingIds: [A, B] }));
    expect(await response.json()).toEqual({
      translations: {
        [A]: { title: "Ventana" },
        [B]: { title: "Puerta de residencia", deliverables: "Una foto del anuncio colocado." },
      },
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    const sent = JSON.parse(String(init.body));
    expect(sent.output_config.format.type).toBe("json_schema");
    expect(sent.system).toContain("Spanish");
    // Only the listing the cache lacked, and only the fields its owner wrote.
    expect(JSON.parse(sent.messages[0].content[0].text.replace(/^[^{]*/, ""))).toEqual({
      listings: [{ id: B, title: "Dorm door", deliverables: "A photo of the ad up." }],
    });

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const [rows, options] = mocks.upsert.mock.calls[0] as [Array<Record<string, unknown>>, unknown];
    expect(options).toEqual({ onConflict: "listing_id,locale" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      listing_id: B,
      locale: "es",
      source_hash: listingSourceHash(listingB),
      fields: { title: "Puerta de residencia", deliverables: "Una foto del anuncio colocado." },
    });
  });

  it("treats a cached row from before the owner's edit as missing", async () => {
    mocks.publicResult = { data: [listingA], error: null };
    mocks.cacheResult = {
      data: [{ listing_id: A, source_hash: "0".repeat(64), fields: { title: "Old words" } }],
      error: null,
    };
    mocks.fetch.mockResolvedValue(modelAnswer([{ id: A, title: "Ventana", description: "Junto a la puerta." }]));
    const response = await POST(makeRequest({ locale: "es", listingIds: [A] }));
    expect(await response.json()).toEqual({
      translations: { [A]: { title: "Ventana", description: "Junto a la puerta." } },
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("still answers with what is cached when the model fails", async () => {
    mocks.publicResult = { data: [listingA, listingB], error: null };
    mocks.cacheResult = {
      data: [{ listing_id: A, source_hash: listingSourceHash(listingA), fields: { title: "Ventana" } }],
      error: null,
    };
    mocks.fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: { message: "down" } }) });
    const response = await POST(makeRequest({ locale: "es", listingIds: [A, B] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ translations: { [A]: { title: "Ventana" } } });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("leaves listings in the owner's language when no provider key is set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    mocks.publicResult = { data: [listingA], error: null };
    const response = await POST(makeRequest({ locale: "fr", listingIds: [A] }));
    expect(await response.json()).toEqual({ translations: {} });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("never sees a listing the public cannot", async () => {
    // The public client returned nothing for this id: hidden, paused, or gone.
    mocks.publicResult = { data: [], error: null };
    const response = await POST(makeRequest({ locale: "ko", listingIds: [A] }));
    expect(await response.json()).toEqual({ translations: {} });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
