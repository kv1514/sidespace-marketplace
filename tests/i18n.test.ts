import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  LOCALES,
  MESSAGES,
  formatCurrency,
  localizeListingUnit,
  localizeRole,
  localeFromAcceptLanguage,
  parseLocale,
  translate,
} from "../lib/i18n";
import { localizedListingCopy } from "../lib/listing-localization";
import {
  compareLocations,
  locationMatchScore,
  normalizeLocation,
} from "../lib/listings/location";

describe("SideSpace locale resolution", () => {
  it("exposes Mandarin Chinese as Simplified Chinese", () => {
    expect(LOCALES).toContainEqual({
      code: "zh",
      label: "Mandarin Chinese",
      nativeLabel: "简体中文",
    });
    expect(parseLocale("zh-CN")).toBe("zh");
    expect(parseLocale("zh-Hans")).toBe("zh");
  });

  it("uses the highest-priority supported Accept-Language entry", () => {
    expect(localeFromAcceptLanguage("ja-JP, zh-CN;q=0.9, en;q=0.8")).toBe("zh");
    expect(localeFromAcceptLanguage("fr-CA;q=0.7, es;q=0.9")).toBe("es");
    expect(localeFromAcceptLanguage("de-DE, *;q=0.5")).toBe(DEFAULT_LOCALE);
  });

  it("keeps every locale catalog complete and interpolates Mandarin copy", () => {
    const keys = Object.keys(MESSAGES.en);

    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale.code])).toEqual(keys);
    }

    expect(translate("zh", "home.heroTitleAccent")).toBe("现在即可预订。");
    expect(translate("zh", "market.openListing", { title: "Fullerton 橱窗" })).toBe(
      "打开 Fullerton 橱窗",
    );
    expect(translate("zh", "how.demo.canIncludeTotal", { amount: "$640.00" })).toBe(
      "可以，加上这项后总价为 $640.00。",
    );
  });

  it("formats monetary values with the active locale", () => {
    expect(formatCurrency("en", 12345)).toContain("123.45");
    expect(formatCurrency("zh", 12345)).toContain("123.45");
  });

  it("translates controlled marketplace labels without changing custom content", () => {
    expect(localizeRole("zh", "creator")).toBe("创作者");
    expect(localizeListingUnit("zh", "week")).toBe("周");
    expect(localizeListingUnit("zh", "custom arrangement")).toBe(
      "custom arrangement",
    );
  });

  it("matches city and area searches without depending on accents or casing", () => {
    expect(normalizeLocation("São Paulo, BR")).toBe("sao paulo, br");
    expect(locationMatchScore("Marfa, TX", "marfa")).toBe(3);
    expect(locationMatchScore("Downtown Fullerton", "fullerton")).toBe(1);
    expect(locationMatchScore("Portland, OR", "Austin")).toBe(0);
    expect(compareLocations("Åre, SE", "Austin, TX", "en-US")).toBeLessThan(0);
  });

  it("uses verified seeded listing copy and preserves unknown live copy", () => {
    const seeded = localizedListingCopy(
      {
        id: "a1111111-1111-4111-8111-111111111111",
        title: "Local story + saved highlight",
        format: "3 frames - 48 hr highlight",
        description: "Original description",
        demographics: "Original audience",
      },
      "zh",
      true,
    );
    expect(seeded.translated).toBe(true);
    expect(seeded.title).toBe("本地故事 + 已保存精选");
    expect(seeded.description).not.toBe("Original description");

    const live = localizedListingCopy(
      {
        id: "live-listing",
        title: "Owner-written title",
        format: "Custom format",
        description: "Owner-written description",
      },
      "zh",
      true,
    );
    expect(live.translated).toBe(false);
    expect(live.title).toBe("Owner-written title");
  });
});
