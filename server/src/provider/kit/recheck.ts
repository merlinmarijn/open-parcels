import { z } from "zod";
import type { SessionStore } from "../api.js";

/**
 * When a fallback tracking service was last asked about each code, kept in the connection's
 * session store. A code is asked again only after `intervalMs`, however often the connection
 * runs, so a paid or shared service is never asked twice about the same code in a short time.
 * Codes no longer tracked are dropped from the record.
 */
const checkedSchema = z.record(z.string(), z.number());

export class RecheckLog {
  readonly #checked: Map<string, number>;

  private constructor(entries: Iterable<[string, number]>) {
    this.#checked = new Map(entries);
  }

  /** Reads the record from `stored` (any shape; a damaged one starts empty). */
  static from(stored: unknown): RecheckLog {
    const parsed = checkedSchema.safeParse(stored);
    return new RecheckLog(parsed.success ? Object.entries(parsed.data) : []);
  }

  /** The codes to ask now: never asked, or last asked at least `intervalMs` ago. */
  due(codes: readonly string[], now: number, intervalMs: number): string[] {
    return codes.filter((code) => {
      const last = this.#checked.get(code);
      return last === undefined || now - last >= intervalMs;
    });
  }

  /** Records that `codes` were asked at `now` and forgets codes not in `tracked`. */
  record(codes: readonly string[], now: number, tracked: readonly string[]): void {
    for (const code of codes) this.#checked.set(code, now);
    const keep = new Set(tracked);
    for (const code of [...this.#checked.keys()]) {
      if (!keep.has(code)) this.#checked.delete(code);
    }
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.#checked);
  }
}

/** The session's stored object, or an empty one. */
export function sessionObject(session: SessionStore): Record<string, unknown> {
  const stored = session.load();
  return typeof stored === "object" && stored !== null && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
}
