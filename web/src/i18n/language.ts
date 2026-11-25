/**
 * The UI language: English or German. It follows the browser (`navigator.languages`, then the
 * locale `Intl` resolves) unless the user picked one on the Settings page; that choice is kept in
 * local storage like the theme. A change reloads the page, so every text and formatter is built
 * once, in one language.
 */
export const LANGUAGES = ["en", "de"] as const;
export type Language = (typeof LANGUAGES)[number];
/** "automatic" follows the browser. */
export type LanguageChoice = Language | "automatic";

const STORAGE_KEY = "open-parcels.language";

function isLanguage(value: string | null | undefined): value is Language {
  return (LANGUAGES as readonly (string | null | undefined)[]).includes(value);
}

function base(tag: string): string {
  return tag.split("-")[0]?.toLowerCase() ?? "";
}

export function storedLanguageChoice(): LanguageChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLanguage(value) ? value : "automatic";
  } catch {
    return "automatic";
  }
}

/** The first supported language the browser asks for; English when it asks for none. */
export function browserLanguage(
  requested: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages,
  intlLocale: string = new Intl.DateTimeFormat().resolvedOptions().locale,
): Language {
  for (const tag of [...requested, intlLocale]) {
    const language = base(tag);
    if (isLanguage(language)) return language;
  }
  return "en";
}

function resolveLanguage(choice: LanguageChoice): Language {
  return choice === "automatic" ? browserLanguage() : choice;
}

/** The language of this page load. */
export const LANGUAGE: Language = resolveLanguage(storedLanguageChoice());

/** Saves the choice and reloads, so the whole UI switches at once. */
export function chooseLanguage(choice: LanguageChoice): void {
  try {
    if (choice === "automatic") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Storage blocked: the choice lasts for nothing; the page keeps the browser's language.
  }
  window.location.reload();
}
