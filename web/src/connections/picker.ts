import type { Carrier } from "../api/types";
import { LANGUAGE, t } from "../i18n";
import { INBOX_PROVIDER } from "./inbox";

/** One row of the "Add a connection" picker: a provider, or the inbox. */
export interface PickerEntry {
  readonly id: string;
  readonly name: string;
  readonly countries: readonly string[];
  readonly aliases: readonly string[];
  readonly logo: string | null;
  /** Inboxes and fallback services: listed in their own section. */
  readonly other: boolean;
}

const regions = new Intl.DisplayNames([LANGUAGE], { type: "region", fallback: "code" });

/** "Germany" for `DE`, "Worldwide" for `*`, in the page's language. */
export function countryName(code: string): string {
  if (code === "*") {
    return t.connections.worldwide;
  }
  try {
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Lower case without accents, so "posta" finds "Pošta" and "osterreich" finds "Österreich". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function haystack(entry: PickerEntry): string {
  const countries = entry.countries.flatMap((code) => [code, countryName(code)]);
  return fold([entry.name, entry.id, ...entry.aliases, ...countries].join(" "));
}

/** Entries matching every word of the query in their name, id, aliases or countries. */
export function searchEntries(entries: readonly PickerEntry[], query: string): PickerEntry[] {
  const words = fold(query)
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) {
    return [...entries];
  }
  return entries.filter((entry) => {
    const text = haystack(entry);
    return words.every((word) => text.includes(word));
  });
}

/** The picker's rows: the inbox and every provider, sorted by name. */
export function pickerEntries(carriers: readonly Carrier[]): PickerEntry[] {
  const inbox: PickerEntry = {
    id: INBOX_PROVIDER,
    name: t.connections.inboxOption,
    countries: [],
    aliases: ["IMAP", "email", t.connections.inboxName],
    logo: null,
    other: true,
  };
  const providers = carriers.map((carrier): PickerEntry => ({
    id: carrier.id,
    name: carrier.name,
    countries: carrier.countries,
    aliases: carrier.aliases,
    logo: carrier.logo,
    other: carrier.fallback,
  }));
  return [inbox, ...providers].sort((a, b) => a.name.localeCompare(b.name, LANGUAGE));
}
