import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The built-in providers' logos (`server/logos/`, sources in its `manifest.json`). This module sits
 * at the top of `src`, like `version.ts`, so `../logos` resolves the same from `src`, `dist` and
 * the bundle (whose chunks sit in `dist/`; `tools/bundle.ts` copies the folder).
 */
const LOGO_DIR = fileURLToPath(new URL("../logos/", import.meta.url));

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  svg: "image/svg+xml",
  png: "image/png",
};

export interface Logo {
  readonly body: Buffer;
  readonly contentType: string;
  /** Short content hash: part of the logo's URL, so it can be cached for good. */
  readonly version: string;
}

function contentType(file: string): string | undefined {
  const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[extension];
}

/** Every logo file in the folder, by file name; read once at start-up. */
export function loadLogos(dir: string = LOGO_DIR): ReadonlyMap<string, Logo> {
  const logos = new Map<string, Logo>();
  for (const file of readdirSync(dir)) {
    const type = contentType(file);
    if (type === undefined) continue;
    const body = readFileSync(`${dir}/${file}`);
    const version = createHash("sha256").update(body).digest("hex").slice(0, 12);
    logos.set(file, { body, contentType: type, version });
  }
  return logos;
}

/** The API path of a provider's logo, or null when it has none (the UI draws a monogram). */
export function logoPath(
  logos: ReadonlyMap<string, Logo>,
  providerId: string,
  file: string | null,
): string | null {
  const logo = file === null ? undefined : logos.get(file);
  return logo === undefined
    ? null
    : `/api/v1/carriers/${encodeURIComponent(providerId)}/logo?v=${logo.version}`;
}
