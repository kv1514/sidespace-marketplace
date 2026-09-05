import { describe, expect, it } from "vitest";

import es from "../lib/i18n/dictionaries/es.json";
import ko from "../lib/i18n/dictionaries/ko.json";
import vi from "../lib/i18n/dictionaries/vi.json";
import zh from "../lib/i18n/dictionaries/zh.json";
import {
  LOCALES,
  createTranslator,
  interpolate,
  localeFromAcceptLanguage,
  msg,
  resolveLocale,
} from "../lib/i18n";
import { allKeys, checkDictionary } from "../scripts/i18n-keys.mjs";

describe("choosing a language", () => {
  it("follows the browser when nobody has chosen", () => {
    expect(localeFromAcceptLanguage("es-419,es;q=0.9,en;q=0.8")).toBe("es");
    expect(localeFromAcceptLanguage("en-US,en;q=0.9,es;q=0.8")).toBe("en");
    expect(localeFromAcceptLanguage("zh-TW,zh;q=0.9")).toBe("zh");
    expect(localeFromAcceptLanguage("ko-KR")).toBe("ko");
    expect(localeFromAcceptLanguage("vi")).toBe("vi");
  });

  it("honours quality values rather than order", () => {
    expect(localeFromAcceptLanguage("fr;q=0.9, es;q=0.5, en;q=0.8")).toBe("en");
  });

  it("falls back to English when the browser asks for nothing we have", () => {
    expect(localeFromAcceptLanguage("fr-FR,fr;q=0.9")).toBeNull();
    expect(resolveLocale(undefined, "fr-FR")).toBe("en");
    expect(resolveLocale(undefined, null)).toBe("en");
  });

  it("lets an explicit choice beat the browser", () => {
    expect(resolveLocale("ko", "es")).toBe("ko");
    expect(resolveLocale("nope", "es")).toBe("es");
  });
});

describe("translating", () => {
  const t = createTranslator("es", { "Sign in": "Iniciar sesión", "Hi {name}": "Hola {name}" });

  it("returns the translation when there is one and the English when there is not", () => {
    expect(t("Sign in")).toBe("Iniciar sesión");
    expect(t("Something new")).toBe("Something new");
  });

  it("fills placeholders in either language", () => {
    expect(t("Hi {name}", { name: "Ana" })).toBe("Hola Ana");
    expect(interpolate("{count} listings", { count: 3 })).toBe("3 listings");
    expect(interpolate("{count} listings", {})).toBe("{count} listings");
    expect(interpolate("{a}", { a: null })).toBe("");
  });

  it("never translates in English, even with a dictionary", () => {
    const english = createTranslator("en", { "Sign in": "Iniciar sesión" });
    expect(english("Sign in")).toBe("Sign in");
  });

  it("marks a string without changing it", () => {
    expect(msg("Storefront")).toBe("Storefront");
  });
});

describe("the dictionaries", () => {
  const keys = allKeys();
  const dictionaries = { es, zh, ko, vi } as const;

  it("cover every sentence the interface can show", () => {
    expect(keys.size).toBeGreaterThan(1500);
    for (const locale of LOCALES) {
      if (locale === "en") continue;
      const { missing } = checkDictionary(dictionaries[locale], keys);
      expect(missing, `${locale} is missing translations`).toEqual([]);
    }
  });

  it("carry nothing the interface no longer says", () => {
    for (const locale of LOCALES) {
      if (locale === "en") continue;
      const { stale } = checkDictionary(dictionaries[locale], keys);
      expect(stale, `${locale} has entries with no source`).toEqual([]);
    }
  });

  it("keep every placeholder the English has", () => {
    for (const locale of LOCALES) {
      if (locale === "en") continue;
      const { mismatched } = checkDictionary(dictionaries[locale], keys);
      expect(mismatched, `${locale} changed a placeholder`).toEqual([]);
    }
  });
});
