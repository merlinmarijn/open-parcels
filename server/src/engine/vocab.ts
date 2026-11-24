import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { appendEvent, type EventBus } from "../events/bus.js";

export interface VocabDeps {
  readonly db: Kysely<Database>;
  readonly bus: EventBus;
  readonly clock: Clock;
}

export interface UnknownValue {
  readonly provider: string;
  readonly kind: string;
  readonly key: string;
}

/**
 * Masks anything shaped like a tracking, order or customer number (a run of six or more letters
 * and digits holding a digit), so free text such as a mail subject can be recorded as a key.
 */
export function maskIdentifiers(text: string): string {
  return text
    .replace(/\b(?=[\p{L}\d-]*\d)[\p{L}\d-]{6,}\b/gu, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** Records an unmapped code or key; warns and fires `vocab.unknown` only the first time. */
export async function recordUnknown(
  deps: VocabDeps,
  value: UnknownValue,
  log: Logger,
): Promise<void> {
  const { provider, kind } = value;
  const now = isoNow(deps.clock);
  const key = value.key.slice(0, 120);
  // One statement, so two writers reporting the same new value count it twice instead of failing.
  const first = await deps.db.transaction().execute(async (trx) => {
    const { count } = await trx
      .insertInto("unknown_vocab")
      .values({ provider, kind, key, first_seen_at: now, last_seen_at: now, count: 1 })
      .onConflict((oc) =>
        oc.columns(["provider", "kind", "key"]).doUpdateSet((eb) => ({
          count: eb("unknown_vocab.count", "+", 1),
          last_seen_at: now,
        })),
      )
      .returning("count")
      .executeTakeFirstOrThrow();
    if (count !== 1) return false;
    await appendEvent(trx, deps.clock, {
      type: "vocab.unknown",
      parcelId: null,
      payload: { provider, kind, key },
    });
    return true;
  });
  if (!first) return;
  await deps.bus.notify();
  log.warn({ provider, kind, key }, "Unrecognised value. Please report it so it can be mapped.");
}
