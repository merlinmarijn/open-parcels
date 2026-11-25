import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * The running version, from `server/package.json` (next to `src/` and `dist/`, and copied into
 * the image), so diagnostics, the API document and outgoing requests all name the same one.
 */
export const VERSION = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).version;

const HOME = "+https://github.com/open-parcels/open-parcels";

/** How this server introduces itself, optionally with what it is and whom to write to. */
export function userAgent(
  notes: { readonly about?: string; readonly contact?: string } = {},
): string {
  const parts = [notes.about, HOME, notes.contact].filter((part) => part !== undefined);
  return `open-parcels/${VERSION} (${parts.join("; ")})`;
}
