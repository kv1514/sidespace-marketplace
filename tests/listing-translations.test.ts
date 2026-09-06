import { describe, expect, it } from "vitest";

import {
  localizedListingCopy,
  readTranslationFields,
  seedTranslationMap,
  translatableText,
  translationKey,
} from "../lib/listings/translations";
import {
  LISTING_TRANSLATION_SCHEMA,
  freshTranslations,
  listingSourceHash,
  readTranslationAnswer,
  translationSystemPrompt,
} from "../lib/listings/translate-server";

const listing = {
  id: "a",
  title: "Cafe window, Main Street",
  format: "one poster in my front window for a week",
  description: "Sits right by the door.",
  demographics: "",
  deliverables: null,
  availability_notes: "   ",
  minimum_booking: undefined,
  cancellation_policy: "Full refund up to 48 hours before.",
};

// The owner's words are the record. A translation replaces prose the owner
// wrote, field by field, and nothing else: an empty field stays empty, a
// field with no translation stays as written, and the listing object the
// rest of the app holds is never mutated.
describe("listing copy in the reader's language", () => {
  it("replaces only what the owner wrote, and never the original object", () => {
    const copy = localizedListingCopy(listing, {
      title: "Ventana de cafetería, Main Street",
      description: "Justo al lado de la puerta.",
      demographics: "Estudiantes",
    });
    expect(copy.title).toBe("Ventana de cafetería, Main Street");
    expect(copy.description).toBe("Justo al lado de la puerta.");
    expect(copy.demographics).toBe("");
    expect(copy.format).toBe("one poster in my front window for a week");
    expect(copy.translated).toBe(true);
    expect(listing.title).toBe("Cafe window, Main Street");
  });

  it("says nothing changed when nothing did", () => {
    expect(localizedListingCopy(listing, null).translated).toBe(false);
    expect(localizedListingCopy(listing, undefined).translated).toBe(false);
    expect(
      localizedListingCopy(listing, { title: "Cafe window, Main Street" }).translated,
    ).toBe(false);
  });

  it("keeps only trimmed, bounded strings in the known fields", () => {
    expect(
      readTranslationFields({
        title: "  Hola  ",
        price_cents: 100,
        description: "",
        format: 12,
        deliverables: "x".repeat(5000),
      }),
    ).toEqual({ title: "Hola" });
    expect(readTranslationFields({})).toBeNull();
    expect(readTranslationFields("nope")).toBeNull();
    expect(readTranslationFields(["title"])).toBeNull();
    expect(readTranslationFields(null)).toBeNull();
  });

  it("sends the model only the fields the owner filled in", () => {
    expect(translatableText(listing)).toEqual({
      title: "Cafe window, Main Street",
      format: "one poster in my front window for a week",
      description: "Sits right by the door.",
      cancellation_policy: "Full refund up to 48 hours before.",
    });
  });

  it("files a page's seed under language and listing", () => {
    expect(
      seedTranslationMap({ locale: "es", byId: { a: { title: "Hola" }, b: { title: "" } } }),
    ).toEqual({ "es:a": { title: "Hola" } });
    expect(seedTranslationMap({ locale: "en", byId: { a: { title: "Hi" } } })).toEqual({});
    expect(seedTranslationMap(null)).toEqual({});
    expect(translationKey("fr", "a")).toBe("fr:a");
  });
});

// A cached translation is only as good as the text it was made from. The
// digest is what ties the two together, so it has to move when the owner
// edits and stay put when nothing meaningful changed.
describe("the translation cache", () => {
  it("changes its digest when the owner edits any field, and not otherwise", () => {
    const digest = listingSourceHash(listing);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(listingSourceHash({ ...listing, description: "  Sits right by the door.  " })).toBe(
      digest,
    );
    expect(listingSourceHash({ ...listing, deliverables: "" })).toBe(digest);
    expect(listingSourceHash({ ...listing, description: "Sits by the window." })).not.toBe(
      digest,
    );
    expect(
      listingSourceHash({ ...listing, title: "", format: "Cafe window, Main Street" }),
    ).not.toBe(digest);
  });

  it("serves a cached row only while its digest still matches the listing", () => {
    const digest = listingSourceHash(listing);
    const other = { ...listing, id: "b", title: "Other window" };
    const rows = [
      { listing_id: "a", source_hash: digest, fields: { title: "Ventana" } },
      // b was edited since: a's digest is not b's.
      { listing_id: "b", source_hash: digest, fields: { title: "Otra" } },
      { listing_id: "c", source_hash: "zzz", fields: { title: "x" } },
      { listing_id: "a", source_hash: digest, fields: 5 },
      null,
    ];
    expect(freshTranslations(rows, [listing, other])).toEqual({ a: { title: "Ventana" } });
    expect(freshTranslations(null, [listing])).toEqual({});
    expect(freshTranslations({ listing_id: "a" }, [listing])).toEqual({});
  });
});

// The model's answer is data, not truth. Only a listing that was asked for,
// only fields the owner wrote, only text that reads as a translation.
describe("what the model hands back", () => {
  const jobs = [{ id: "a", fields: { title: "Cafe window", description: "By the door." } }];

  it("keeps a translation for a field the owner wrote, for a listing that was asked", () => {
    const text = JSON.stringify({
      listings: [
        {
          id: "a",
          title: "Ventana de cafetería",
          description: "Junto a la puerta.",
          format: "invented by the model",
          demographics: "",
        },
        { id: "zzz", title: "nobody asked" },
        "garbage",
      ],
    });
    expect(readTranslationAnswer(text, jobs)).toEqual({
      a: { title: "Ventana de cafetería", description: "Junto a la puerta." },
    });
  });

  it("drops an answer that is not JSON or not the shape", () => {
    expect(readTranslationAnswer("not json", jobs)).toEqual({});
    expect(readTranslationAnswer(JSON.stringify({ listings: "x" }), jobs)).toEqual({});
    expect(readTranslationAnswer(JSON.stringify([{ id: "a", title: "x" }]), jobs)).toEqual({});
  });

  it("names the reader's language and demands every field back, by id", () => {
    expect(translationSystemPrompt("es")).toContain("Spanish");
    expect(translationSystemPrompt("zh")).toContain("Simplified Chinese");
    expect(translationSystemPrompt("vi")).toContain("Vietnamese");
    expect(translationSystemPrompt("es")).toContain("SideSpace stays SideSpace");
    const item = LISTING_TRANSLATION_SCHEMA.properties.listings.items;
    expect(item.required).toEqual([
      "id",
      "title",
      "format",
      "description",
      "demographics",
      "deliverables",
      "availability_notes",
      "minimum_booking",
      "cancellation_policy",
    ]);
    expect(item.additionalProperties).toBe(false);
  });
});
