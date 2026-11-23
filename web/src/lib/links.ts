/**
 * A link the UI may render or open: absolute `http:` or `https:` only, else null. The server
 * cleans stored links too; this is the last check before the user's click, so a link that slipped
 * through (`javascript:`, `data:`, an app scheme) is shown as plain text instead.
 */
export function safeHref(url: string | null | undefined, schemes = ["http:", "https:"]): string | null {
  if (url === null || url === undefined) {
    return null;
  }
  try {
    return schemes.includes(new URL(url).protocol) ? url : null;
  } catch {
    // Not an absolute address at all: nothing to link to.
    return null;
  }
}
