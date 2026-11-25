import type { Kysely } from "kysely";
import { addMs, isoNow, type Clock } from "../clock.js";
import type { Database, SyncChangeTable } from "../db/schema.js";
import { parcelVisible } from "../db/visibility.js";
import { parseStatus, type HistoryEntry, type Parcel } from "../domain/parcel.js";
import type { Order } from "../domain/order-lifecycle.js";
import type { Return } from "../domain/return.js";
import type { ConnectionService, ConnectionView } from "../engine/connections.js";
import type { OrderService } from "../orders/service.js";
import type { ParcelRepository } from "../parcels/repository.js";
import type { ReturnService } from "../returns/service.js";

export const SYNC_ENTITIES = ["parcel", "event", "order", "return", "connection"] as const;
export type SyncEntity = SyncChangeTable["entity"];

/** Tombstones are kept this long; a client that has not synced for longer loads everything. */
export const TOMBSTONE_DAYS = 90;
/** The newest `seq` whose tombstones were pruned: cursors before it are too old. */
const FLOOR_KEY = "sync_floor";

export interface SyncEvent extends HistoryEntry {
  readonly id: string;
  readonly parcel_id: string;
  readonly updated_at: string;
}

export interface SyncPage {
  readonly cursor: string;
  readonly more: boolean;
  readonly parcels: Parcel[];
  readonly events: SyncEvent[];
  readonly orders: Order[];
  readonly returns: Return[];
  readonly connections: ConnectionView[];
  readonly deleted: { readonly type: SyncEntity; readonly id: string }[];
}

export interface SyncSources {
  readonly parcels: ParcelRepository;
  readonly orders: OrderService;
  readonly returns: ReturnService;
  readonly connections: ConnectionService;
}

/**
 * Delta sync (docs/sync.md): what changed after a cursor, read from `sync_changes`, which triggers
 * keep (`db/sync-triggers.ts`). The cursor is the last `seq` a page covered, as a string clients
 * must not interpret. An entity a client may no longer see (deleted, or hidden because every
 * connection that reported it is disabled) is listed under `deleted`.
 */
export class SyncService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly sources: SyncSources,
  ) {}

  /** The page after `since` (0: from the start); `expired` when the cursor cannot be continued. */
  async changes(since: number, limit: number): Promise<SyncPage | "expired"> {
    if (since > 0 && (since < (await this.#floor()) || since > (await this.#newest()))) {
      return "expired";
    }
    const rows = await this.db
      .selectFrom("sync_changes")
      .select(["seq", "entity", "entity_id", "deleted"])
      .where("seq", ">", since)
      .orderBy("seq")
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const live = (entity: SyncEntity): string[] =>
      page.filter((row) => row.entity === entity && row.deleted === 0).map((row) => row.entity_id);
    const [parcels, events, orders, returns, connections] = await Promise.all([
      this.sources.parcels.visibleByIds(live("parcel")),
      this.#events(live("event")),
      this.sources.orders.byIds(live("order")),
      this.sources.returns.byIds(live("return")),
      this.#connections(live("connection")),
    ]);
    const key = (type: SyncEntity, id: string): string => `${type}:${id}`;
    const shown = new Set<string>([
      ...parcels.map((entry) => key("parcel", entry.id)),
      ...events.map((entry) => key("event", entry.id)),
      ...orders.map((entry) => key("order", entry.id)),
      ...returns.map((entry) => key("return", entry.id)),
      ...connections.map((entry) => key("connection", entry.id)),
    ]);
    return {
      cursor: String(page.at(-1)?.seq ?? since),
      more: rows.length > limit,
      parcels,
      events,
      orders,
      returns,
      connections,
      deleted: page
        .filter((row) => row.deleted === 1 || !shown.has(key(row.entity, row.entity_id)))
        .map((row) => ({ type: row.entity, id: row.entity_id })),
    };
  }

  /** Drops tombstones older than `TOMBSTONE_DAYS` and raises the floor past them. */
  async pruneTombstones(): Promise<number> {
    const cutoff = addMs(this.clock.now(), -TOMBSTONE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    return this.db.transaction().execute(async (trx) => {
      const newest = await trx
        .selectFrom("sync_changes")
        .select((eb) => eb.fn.max("seq").as("seq"))
        .where("deleted", "=", 1)
        .where("changed_at", "<", cutoff)
        .executeTakeFirst();
      const seq = newest?.seq ?? null;
      if (seq === null) return 0;
      const result = await trx
        .deleteFrom("sync_changes")
        .where("deleted", "=", 1)
        .where("seq", "<=", seq)
        .executeTakeFirst();
      await trx
        .insertInto("settings")
        .values({ key: FLOOR_KEY, value: JSON.stringify(seq), updated_at: isoNow(this.clock) })
        .onConflict((oc) =>
          oc
            .column("key")
            .doUpdateSet({ value: JSON.stringify(seq), updated_at: isoNow(this.clock) }),
        )
        .execute();
      return Number(result.numDeletedRows);
    });
  }

  async #floor(): Promise<number> {
    const row = await this.db
      .selectFrom("settings")
      .select("value")
      .where("key", "=", FLOOR_KEY)
      .executeTakeFirst();
    return row === undefined ? 0 : Number(JSON.parse(row.value));
  }

  async #newest(): Promise<number> {
    const row = await this.db
      .selectFrom("sync_changes")
      .select((eb) => eb.fn.max("seq").as("seq"))
      .executeTakeFirst();
    return row?.seq ?? 0;
  }

  async #events(ids: readonly string[]): Promise<SyncEvent[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom("parcel_events")
      .selectAll()
      .where("id", "in", ids.map(Number))
      .where("parcel_id", "in", this.db.selectFrom("parcels").select("id").where(parcelVisible))
      .orderBy("id")
      .execute();
    return rows.map((event) => ({
      id: String(event.id),
      parcel_id: event.parcel_id,
      timestamp: event.at,
      status: parseStatus(event.status),
      raw_status: event.raw_status,
      location: event.location_text,
      latitude: event.latitude,
      longitude: event.longitude,
      approximate: event.geocoded === 1 && event.latitude !== null,
      updated_at: event.updated_at,
    }));
  }

  async #connections(ids: readonly string[]): Promise<ConnectionView[]> {
    if (ids.length === 0) return [];
    const wanted = new Set(ids);
    return (await this.sources.connections.list()).filter((view) => wanted.has(view.id));
  }
}
