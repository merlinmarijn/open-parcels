import type { Kysely } from "kysely";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { deleteOrders, deleteParcels } from "./bulk-delete.js";
import type { Presentation } from "./repository.js";

/** What clearing a source removes, or would remove. */
export interface SourceDataCounts {
  /** Parcels only this source reported: deleted with their history and items. */
  readonly parcels: number;
  /** Orders only this source reported: deleted with their items. */
  readonly orders: number;
  /** Parcels and orders other sources also reported: they stay, only this source's link goes. */
  readonly shared: number;
}

interface Deps {
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  readonly presentation: Presentation;
}

async function exclusiveParcels(db: Kysely<Database>, sourceId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("parcel_sources as mine")
    .select("mine.parcel_id")
    .where("mine.source_id", "=", sourceId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("parcel_sources as other")
            .select("other.parcel_id")
            .whereRef("other.parcel_id", "=", "mine.parcel_id")
            .where("other.source_id", "!=", sourceId),
        ),
      ),
    )
    .execute();
  return rows.map((row) => row.parcel_id);
}

async function exclusiveOrders(db: Kysely<Database>, sourceId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("order_sources as mine")
    .select("mine.order_id")
    .where("mine.source_id", "=", sourceId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("order_sources as other")
            .select("other.order_id")
            .whereRef("other.order_id", "=", "mine.order_id")
            .where("other.source_id", "!=", sourceId),
        ),
      ),
    )
    .execute();
  return rows.map((row) => row.order_id);
}

async function linkCount(db: Kysely<Database>, sourceId: string): Promise<number> {
  const parcels = await db
    .selectFrom("parcel_sources")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("source_id", "=", sourceId)
    .executeTakeFirst();
  const orders = await db
    .selectFrom("order_sources")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("source_id", "=", sourceId)
    .executeTakeFirst();
  return (parcels?.n ?? 0) + (orders?.n ?? 0);
}

/** Counts what `clearSourceData` would remove, for the confirmation dialog. */
export async function countSourceData(
  db: Kysely<Database>,
  sourceId: string,
): Promise<SourceDataCounts> {
  const parcels = await exclusiveParcels(db, sourceId);
  const orders = await exclusiveOrders(db, sourceId);
  const links = await linkCount(db, sourceId);
  return {
    parcels: parcels.length,
    orders: orders.length,
    shared: links - parcels.length - orders.length,
  };
}

/**
 * Removes everything a source imported, so it can sync or import again from scratch: parcels and
 * orders only it reported are deleted (firing `parcel.deleted` and `order.deleted`), its links,
 * raw payloads and mail progress go, and data other sources also reported stays. The source itself
 * and its sign-in are kept. Deleted orders are removed outright, not kept as tombstones, so the
 * next sync may create them again.
 */
export async function clearSourceData(deps: Deps, sourceId: string): Promise<SourceDataCounts> {
  const { db, clock, presentation } = deps;
  return db.transaction().execute(async (trx) => {
    const counts = await countSourceData(trx, sourceId);
    await deleteParcels(trx, clock, presentation, await exclusiveParcels(trx, sourceId), sourceId);
    await deleteOrders(trx, clock, await exclusiveOrders(trx, sourceId));
    await trx.deleteFrom("parcel_sources").where("source_id", "=", sourceId).execute();
    await trx.deleteFrom("order_sources").where("source_id", "=", sourceId).execute();
    await trx.deleteFrom("parcel_raw").where("source_id", "=", sourceId).execute();
    // A mailbox keeps only its read position as session; dropping it reads the mails again.
    await trx
      .updateTable("sources")
      .set({ session_blob: null })
      .where("id", "=", sourceId)
      .where("kind", "=", "mail")
      .execute();
    return counts;
  });
}
