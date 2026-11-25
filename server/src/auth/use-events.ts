import type { Kysely } from "kysely";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { appendEvent, type EventBus } from "../events/bus.js";

/** What was used: an API token or a token login (`GET /api/v1/tokens`, `/api/v1/logins`). */
interface TokenUse {
  readonly kind: "token" | "login";
  readonly id: string;
  readonly lastUsedAt: string;
}

/** Records that a token or login was used, after its "last used" time was stored. */
export type UseRecorder = (use: TokenUse) => Promise<void>;

export const IGNORE_USE: UseRecorder = () => Promise.resolve();

/** Announces each stored use as a `token.used` live event, so the Tokens page need not poll. */
export function announceUses(db: Kysely<Database>, clock: Clock, bus: EventBus): UseRecorder {
  return async (use) => {
    await appendEvent(db, clock, {
      type: "token.used",
      parcelId: null,
      payload: { kind: use.kind, id: use.id, last_used_at: use.lastUsedAt },
    });
    await bus.notify();
  };
}
