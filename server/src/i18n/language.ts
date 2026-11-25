/** Languages the server has its own texts in; English is the source and the fallback. */
export const LANGUAGES = ["en", "de"] as const;
export type Language = (typeof LANGUAGES)[number];

const isLanguage = (value: string): value is Language =>
  (LANGUAGES as readonly string[]).includes(value);

/**
 * The language a request asks for in `Accept-Language`: the supported one with the highest
 * weight, English when it names none. The web UI sends its own choice; other clients get English.
 */
export function requestLanguage(header: string | undefined): Language {
  if (header === undefined) return "en";
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([\d.]+)\s*$/u.exec(p)?.[1]).find((v) => v !== undefined);
      return {
        base: tag.split("-")[0]?.toLowerCase() ?? "",
        weight: q === undefined ? 1 : Number(q),
        index,
      };
    })
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  return ranked.map((entry) => entry.base).find(isLanguage) ?? "en";
}
