import type { Kysely } from "kysely";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { appendEvent } from "../events/bus.js";
import { parcelEventPayload } from "../events/payload.js";
import type { EventType } from "../events/types.js";
import { ParcelRepository, RAW_PRESENTATION, type Presentation } from "../parcels/repository.js";

/**
 * Appends one event per parcel with its state after a start-up repair, inside the repair's
 * transaction, so clients that keep state from events (Home Assistant) follow the change.
 */
export async function appendParcelEvents(
  trx: Kysely<Database>,
  clock: Clock,
  type: EventType,
  ids: readonly string[],
  presentation: Presentation = RAW_PRESENTATION,
): Promise<void> {
  const repository = new ParcelRepository(trx, presentation);
  for (const id of ids) {
    const parcel = await repository.get(id);
    if (parcel !== undefined) {
      await appendEvent(trx, clock, {
        type,
        parcelId: id,
        payload: parcelEventPayload({ ...parcel, history: [] }),
      });
    }
  }
}
