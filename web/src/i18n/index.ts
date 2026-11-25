import { de } from "./de";
import { LANGUAGE, type Language } from "./language";
import { en, type Messages } from "./messages";

const DICTIONARIES: Readonly<Record<Language, Messages>> = { en, de };

/** The texts of this page load's language: `t.parcels.title`, `t.parcels.count(3)`. */
export const t: Messages = DICTIONARIES[LANGUAGE];

/** The product name, the same in every language. */
export const BRAND = "Open Parcels";

export { chooseLanguage, LANGUAGE, LANGUAGES, storedLanguageChoice } from "./language";
export type { LanguageChoice } from "./language";
