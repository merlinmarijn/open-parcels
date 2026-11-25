import type { Language } from "./language.js";
import { PROVIDER_TEXTS_DE } from "./provider-texts-de.js";

const TABLES: Readonly<Record<Exclude<Language, "en">, Readonly<Record<string, string>>>> = {
  de: PROVIDER_TEXTS_DE,
};

/**
 * A provider's own text (a sign-in flow label, a step text, a form field title) in `language`.
 * Providers write English; the tables are keyed by that English text. A text without an entry,
 * such as one a carrier sent, stays English.
 */
export function providerText(language: Language, text: string): string {
  if (language === "en") return text;
  return TABLES[language][text] ?? text;
}

/** Whether `text` has an entry in every table; the provider test checks each text with it. */
export function hasProviderText(text: string): boolean {
  return Object.values(TABLES).every((table) => text in table);
}

/**
 * A JSON Schema with its `title` and `description` texts translated, at every depth. A string under
 * one of those keys is always a text: a field named `title` sits under `properties` as an object.
 */
export function localizeSchema(language: Language, schema: unknown): unknown {
  if (language === "en") return schema;
  if (Array.isArray(schema)) return schema.map((item) => localizeSchema(language, item));
  if (typeof schema !== "object" || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      (key === "title" || key === "description") && typeof value === "string"
        ? providerText(language, value)
        : localizeSchema(language, value),
    ]),
  );
}
