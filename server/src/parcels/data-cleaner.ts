import { sql, type Kysely } from "kysely";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import type { EventBus } from "../events/bus.js";
import { deleteOrders, deleteParcels } from "./bulk-delete.js";
import type { Presentation } from "./repository.js";

/** What a clean-up removed. */
export interface Cleared {
  readonly parcels: number;
  readonly orders: number;
  readonly rows: number;
}

interface Deps {
  readonly db: Kysely<Database>;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly presentation: Presentation;
}

/**
 * The owner's clean-up actions on the Data page. Nothing here runs on its own: data is kept until
 * the owner deletes it (automatic deletion is an opt-in setting, see retention).
 */
export class DataCleaner {
  constructor(private readonly deps: Deps) {}

  /** Archived parcels, with their history and items. */
  async archived(): Promise<Cleared> {
    return this.#parcels((db) =>
      db.selectFrom("parcels").select("id").where("archived_at", "is not", null),
    );
  }

  /**
   * Finished parcels (delivered or archived) last seen before `before`, then orders placed
   * before it that have no parcel left. Parcels still on their way are never touched.
   */
  async olderThan(before: Date): Promise<Cleared> {
    const iso = before.toISOString();
    const parcels = await this.#parcels((db) =>
      db
        .selectFrom("parcels")
        .select("id")
        .where((eb) => eb.or([eb("delivered", "=", 1), eb("archived_at", "is not", null)]))
        .where((eb) => eb.fn.coalesce("delivered_at", "archived_at", "last_seen_at"), "<", iso),
    );
    const orders = await this.#orders((db) =>
      db
        .selectFrom("orders")
        .select("id")
        .where((eb) => eb.fn.coalesce("placed_at", "created_at"), "<", iso)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("parcels")
                .select("parcels.id")
                .whereRef("parcels.order_id", "=", "orders.id"),
            ),
          ),
        ),
    );
    return { parcels: parcels.parcels, orders: orders.orders, rows: 0 };
  }

  /** Raw carrier payloads, kept only for diagnosing a provider. */
  async rawPayloads(): Promise<Cleared> {
    const result = await this.deps.db.deleteFrom("parcel_raw").executeTakeFirst();
    return { parcels: 0, orders: 0, rows: Number(result.numDeletedRows) };
  }

  /** The tracking scans of archived parcels; the parcels themselves stay. */
  async archivedScans(): Promise<Cleared> {
    const result = await this.deps.db
      .deleteFrom("parcel_events")
      .where("parcel_id", "in", (eb) =>
        eb.selectFrom("parcels").select("parcels.id").where("parcels.archived_at", "is not", null),
      )
      .executeTakeFirst();
    return { parcels: 0, orders: 0, rows: Number(result.numDeletedRows) };
  }

  /**
   * Every parcel and order, including the tombstones of deleted orders, so every connection imports
   * from scratch. Connections, sign-ins, settings and tokens stay. The caller backs up first.
   */
  async everything(): Promise<Cleared> {
    const parcels = await this.#parcels((db) => db.selectFrom("parcels").select("id"));
    const orders = await this.#orders((db) => db.selectFrom("orders").select("id"));
    await sql`delete from parcel_raw`.execute(this.deps.db);
    return { parcels: parcels.parcels, orders: orders.orders, rows: 0 };
  }

  async #parcels(
    select: (db: Kysely<Database>) => { execute(): Promise<{ id: string }[]> },
  ): Promise<Cleared> {
    const { db, clock, presentation, bus } = this.deps;
    const deleted = await db.transaction().execute(async (trx) => {
      const ids = (await select(trx).execute()).map((row) => row.id);
      return deleteParcels(trx, clock, presentation, ids);
    });
    await bus.notify();
    return { parcels: deleted, orders: 0, rows: 0 };
  }

  async #orders(
    select: (db: Kysely<Database>) => { execute(): Promise<{ id: string }[]> },
  ): Promise<Cleared> {
    const { db, clock, bus } = this.deps;
    const deleted = await db.transaction().execute(async (trx) => {
      const ids = (await select(trx).execute()).map((row) => row.id);
      return deleteOrders(trx, clock, ids);
    });
    await bus.notify();
    return { parcels: 0, orders: deleted, rows: 0 };
  }
}
