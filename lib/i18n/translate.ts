import { DEFAULT_LOCALE, type Locale } from "./locales";

/**
 * English is the key.
 *
 * Every dictionary maps the English sentence a component was written with to
 * its translation, so the source stays readable as prose and a missing entry
 * falls back to the English rather than to a bare identifier. Placeholders
 * are `{name}` and must survive translation untouched; the dictionary test
 * checks that they do.
 */

export type Dictionary = Readonly<Record<string, string>>;

export type Vars = Readonly<Record<string, string | number | null | undefined>>;

export interface Translate {
  (text: string, vars?: Vars): string;
  readonly locale: Locale;
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? "") : match,
  );
}

export function createTranslator(
  locale: Locale,
  dictionary: Dictionary,
): Translate {
  const translate = (text: string, vars?: Vars) => {
    const found = locale === DEFAULT_LOCALE ? undefined : dictionary[text];
    return interpolate(found || text, vars);
  };
  return Object.assign(translate, { locale });
}

/** English, with no dictionary: what a helper uses when nobody handed it a language. */
export const english: Translate = createTranslator(DEFAULT_LOCALE, {});

/**
 * Marks a string written outside a component - a chip label, a role name -
 * as interface text, so the dictionary check knows to expect it. It returns
 * its argument; the translation happens where the string is rendered.
 */
export function msg(text: string): string {
  return text;
}
