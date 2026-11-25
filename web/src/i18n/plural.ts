import { LANGUAGE } from "./language";

const rules = new Intl.PluralRules(LANGUAGE);

/** Picks the form for `count` ("1 parcel", "3 parcels"); English and German need one and other. */
export function plural(count: number, one: string, other: string): string {
  return rules.select(count) === "one" ? one : other;
}
