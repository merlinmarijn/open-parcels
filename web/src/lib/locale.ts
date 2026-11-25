import { LANGUAGE } from "../i18n/language";

/**
 * The region of the locale `Intl` resolves by default, which follows the system's regional
 * settings. `navigator.languages` is deliberately not used for it: privacy-hardened browsers
 * report "en-US" there whatever the user's region (seen: "en-US" in navigator.languages, "en-DE"
 * from Intl).
 */
function systemRegion(): string | undefined {
  try {
    return new Intl.Locale(new Intl.DateTimeFormat().resolvedOptions().locale).region;
  } catch {
    return undefined;
  }
}

/**
 * The locale every date, time and number in the UI is formatted with: the UI language with the
 * system's region ("de-DE", "en-DE", "en-US"), so month names match the language of the texts
 * around them and the formats match the user's region.
 */
export function uiLocale(language: string, region: string | undefined): string {
  if (region === undefined) return language;
  try {
    return new Intl.Locale(language, { region }).toString();
  } catch {
    return language;
  }
}

export const UI_LOCALE: string = uiLocale(LANGUAGE, systemRegion());

/** True when the locale writes times with am/pm. */
export const UI_HOUR12: boolean = (() => {
  const cycle = new Intl.DateTimeFormat(UI_LOCALE, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h11" || cycle === "h12";
})();

const numbers = new Intl.NumberFormat(UI_LOCALE);

/** A number in the user's locale ("1,234" or "1.234"). */
export function formatNumber(value: number): string {
  return numbers.format(value);
}
