import type { Kysely } from "kysely";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { deleteOrders, deleteParcels } from "./bulk-delete.js";
import type { Presentation } from "./repository.js";

/** What clearing a connection removes, or would remove. */
export interface ConnectionDataCounts {
  /** Parcels only this connection reported: deleted with their history and items. */
  readonly parcels: number;
  /** Orders only this connection reported: deleted with their items. */
  readonly orders: number;
  /** Parcels and orders other connections also reported: they stay, only this connection's link goes. */
  readonly shared: number;
}

interface Deps {
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  readonly presentation: Presentation;
}

async function exclusiveParcels(db: Kysely<Database>, connectionId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("parcel_connections as mine")
    .select("mine.parcel_id")
    .where("mine.connection_id", "=", connectionId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("parcel_connections as other")
            .select("other.parcel_id")
            .whereRef("other.parcel_id", "=", "mine.parcel_id")
            .where("other.connection_id", "!=", connectionId),
        ),
      ),
    )
    .execute();
  return rows.map((row) => row.parcel_id);
}

async function exclusiveOrders(db: Kysely<Database>, connectionId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("order_connections as mine")
    .select("mine.order_id")
    .where("mine.connection_id", "=", connectionId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("order_connections as other")
            .select("other.order_id")
            .whereRef("other.order_id", "=", "mine.order_id")
            .where("other.connection_id", "!=", connectionId),
        ),
      ),
    )
    .execute();
  return rows.map((row) => row.order_id);
}

async function linkCount(db: Kysely<Database>, connectionId: string): Promise<number> {
  const parcels = await db
    .selectFrom("parcel_connections")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("connection_id", "=", connectionId)
    .executeTakeFirst();
  const orders = await db
    .selectFrom("order_connections")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("connection_id", "=", connectionId)
    .executeTakeFirst();
  return (parcels?.n ?? 0) + (orders?.n ?? 0);
}

/** Counts what `clearConnectionData` would remove, for the confirmation dialog. */
export async function countConnectionData(
  db: Kysely<Database>,
  connectionId: string,
): Promise<ConnectionDataCounts> {
  const parcels = await exclusiveParcels(db, connectionId);
  const orders = await exclusiveOrders(db, connectionId);
  const links = await linkCount(db, connectionId);
  return {
    parcels: parcels.length,
    orders: orders.length,
    shared: links - parcels.length - orders.length,
  };
}

/**
 * Removes everything a connection imported, so it can sync or import again from scratch: parcels and
 * orders only it reported are deleted (firing `parcel.deleted` and `order.deleted`), its links,
 * raw payloads and mail progress go, and data other connections also reported stays. The connection itself
 * and its sign-in are kept. Deleted orders are removed outright, not kept as tombstones, so the
 * next sync may create them again.
 */
export async function clearConnectionData(
  deps: Deps,
  connectionId: string,
): Promise<ConnectionDataCounts> {
  const { db, clock, presentation } = deps;
  return db.transaction().execute(async (trx) => {
    const counts = await countConnectionData(trx, connectionId);
    await deleteParcels(
      trx,
      clock,
      presentation,
      await exclusiveParcels(trx, connectionId),
      connectionId,
    );
    await deleteOrders(trx, clock, await exclusiveOrders(trx, connectionId));
    await trx.deleteFrom("parcel_connections").where("connection_id", "=", connectionId).execute();
    await trx.deleteFrom("order_connections").where("connection_id", "=", connectionId).execute();
    await trx.deleteFrom("parcel_raw").where("connection_id", "=", connectionId).execute();
    // An inbox keeps only its read position as session; dropping it reads the mails again.
    await trx
      .updateTable("connections")
      .set({ session_blob: null })
      .where("id", "=", connectionId)
      .where("kind", "=", "mail")
      .execute();
    return counts;
  });
}
