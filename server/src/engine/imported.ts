import { sql, type Transaction } from "kysely";
import { DAY_MS, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { appendEvent } from "../events/bus.js";

/**
 * Imported history is not news (`docs/connection-actions-and-jobs.md` §6): what an import job
 * stores is flagged `imported_at`, its live events carry `imported: true`, a parcel delivered
 * long ago is stored archived without events, and one `parcel.imported` sums up each batch.
 */

type Trx = Transaction<Database>;

/** An imported parcel delivered longer ago than this is stored archived, without events. */
const OLD_DELIVERY_DAYS = 30;

/** Whether an imported parcel's delivery is old history rather than something to announce. */
export function deliveredLongAgo(
  state: { readonly delivered: boolean; readonly deliveredAt: string | null },
  now: Date,
): boolean {
  if (!state.delivered || state.deliveredAt === null) return false;
  const at = Date.parse(state.deliveredAt);
  return !Number.isNaN(at) && now.getTime() - at > OLD_DELIVERY_DAYS * DAY_MS;
}

/** The newest outbox sequence number, 0 for an empty outbox. */
export async function lastSeq(trx: Trx): Promise<number> {
  const row = await trx
    .selectFrom("outbox")
    .select((eb) => eb.fn.max("seq").as("seq"))
    .executeTakeFirst();
  return row?.seq ?? 0;
}

/** What one stored batch of an import job did, for `parcel.imported`. */
export interface ImportCounts {
  readonly created: number;
  readonly updated: number;
  /** New parcels stored archived because they were delivered long ago. */
  readonly archived: number;
  /** Order reports of the batch. */
  readonly orders: number;
}

/**
 * Marks every live event appended since `since` (in this transaction, which holds the database)
 * as imported, then appends the batch's `parcel.imported`.
 */
export async function closeImport(
  trx: Trx,
  clock: Clock,
  since: number,
  connection: { readonly id: string; readonly provider: string },
  counts: ImportCounts,
): Promise<void> {
  await trx
    .updateTable("outbox")
    .set({ payload: sql<string>`json_set(payload, '$.imported', json('true'))` })
    .where("seq", ">", since)
    .where(sql<boolean>`json_type(payload) = 'object'`)
    .execute();
  if (counts.created + counts.updated + counts.orders === 0) return;
  await appendEvent(trx, clock, {
    type: "parcel.imported",
    parcelId: null,
    payload: {
      connection: { id: connection.id, provider: connection.provider },
      ...counts,
      imported: true,
    },
  });
}
