import type { Kysely } from "kysely";
import type { Clock } from "../clock.js";
import type { Database, ParcelRow } from "../db/schema.js";
import { RAW_PRESENTATION, type Presentation } from "../parcels/repository.js";
import { normaliseTrackingNumber } from "./tracking-number.js";
import { foldParcel } from "./fold.js";
import { appendParcelEvents } from "./repair-events.js";

export interface TrackingNumberRepair {
  /** Parcels whose code was rewritten in the carrier's spelling. */
  readonly respelled: number;
  /** Parcels folded into a twin that differed only in case or spaces. */
  readonly folded: number;
}

/**
 * Stores every code in its carrier's spelling (see `normaliseTrackingNumber`). Codes that differed only
 * in case or spaces (`1z 999…` typed by hand, `1Z999…` echoed by the carrier) were two parcels;
 * they become one, kept under the oldest, with the others folded in. Idempotent.
 */
export async function repairTrackingNumbers(
  db: Kysely<Database>,
  clock: Clock,
  presentation: Presentation = RAW_PRESENTATION,
): Promise<TrackingNumberRepair> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("parcels")
      .selectAll()
      .orderBy("first_seen_at")
      .orderBy("id")
      .execute();
    const groups = new Map<string, { spelling: string; rows: ParcelRow[] }>();
    for (const row of rows) {
      const spelling = normaliseTrackingNumber(row.carrier, row.tracking_number);
      const key = JSON.stringify([row.carrier, spelling]);
      const group = groups.get(key) ?? { spelling, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    let respelled = 0;
    let folded = 0;
    for (const { spelling, rows: twins } of groups.values()) {
      const [keep, ...others] = twins;
      if (keep === undefined) {
        continue;
      }
      for (const other of others) {
        await foldParcel(trx, { clock, presentation }, other, keep);
        folded += 1;
      }
      // An active twin keeps the parcel active.
      const revive = keep.removed_at !== null && others.some((row) => row.removed_at === null);
      if (keep.tracking_number !== spelling || revive) {
        await trx
          .updateTable("parcels")
          .set({ tracking_number: spelling, ...(revive ? { removed_at: null } : {}) })
          .where("id", "=", keep.id)
          .execute();
        respelled += keep.tracking_number === spelling ? 0 : 1;
        if (revive) {
          // Clients dropped it on `parcel.removed`; an active twin brings it back.
          await appendParcelEvents(trx, clock, "parcel.registered", [keep.id], presentation);
        }
      }
    }
    return { respelled, folded };
  });
}
