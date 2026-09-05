import type { Locale } from "./locales";
import type { Dictionary } from "./translate";

const ENGLISH: Dictionary = {};

/** One file per language, loaded only for the language in use. */
export async function loadDictionary(locale: Locale): Promise<Dictionary> {
  switch (locale) {
    case "es":
      return (await import("./dictionaries/es.json")).default;
    case "zh":
      return (await import("./dictionaries/zh.json")).default;
    case "ko":
      return (await import("./dictionaries/ko.json")).default;
    case "vi":
      return (await import("./dictionaries/vi.json")).default;
    default:
      return ENGLISH;
  }
}
