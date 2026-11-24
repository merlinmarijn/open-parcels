import { CookieJar } from "tough-cookie";

export { CookieJar };

/**
 * Restores a cookie jar from a provider's session store value. Anything that is not a jar the
 * provider saved earlier yields an empty jar, so a corrupt session means "sign in again", never a crash.
 */
export function restoreJar(saved: unknown): CookieJar {
  if (saved === null || typeof saved !== "object") {
    return new CookieJar();
  }
  try {
    return CookieJar.deserializeSync(saved as Parameters<typeof CookieJar.deserializeSync>[0]);
  } catch {
    // A jar that no longer deserialises (format change, damaged data) is replaced by a fresh one;
    // the carrier then asks for a new sign-in, which the provider reports properly.
    return new CookieJar();
  }
}

/** A JSON-safe form of the jar for the encrypted session store. */
export function serializeJar(jar: CookieJar): unknown {
  return jar.serializeSync() ?? null;
}
