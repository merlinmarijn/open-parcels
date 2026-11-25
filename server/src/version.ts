import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * The running version, from `server/package.json` (next to `src/` and `dist/`, and copied into
 * the image), so diagnostics, the API document and outgoing requests all name the same one.
 */
export const VERSION = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).version;

/**
 * The git commit the image was built from, shortened to 7 characters: the Docker build bakes it in
 * as `OPENPARCELS_COMMIT`. Null when running from a checkout or when the value is not a commit.
 */
export function commitFrom(value: string | undefined): string | null {
  return value !== undefined && /^[0-9a-f]{7,40}$/i.test(value)
    ? value.slice(0, 7).toLowerCase()
    : null;
}

export const COMMIT = commitFrom(process.env["OPENPARCELS_COMMIT"]);

const HOME = "+https://github.com/open-parcels/open-parcels";

/** How this server introduces itself, optionally with what it is and whom to write to. */
export function userAgent(
  notes: { readonly about?: string; readonly contact?: string } = {},
): string {
  const parts = [notes.about, HOME, notes.contact].filter((part) => part !== undefined);
  return `open-parcels/${VERSION} (${parts.join("; ")})`;
}
