import type { Kysely, Selectable } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { Database, OrderTable } from "../db/schema.js";
import { orderVisible } from "../db/visibility.js";
import {
  inView,
  orderArchivedAt,
  orderStatus,
  orderTotal,
  type Order,
  type OrderView,
} from "../domain/order-lifecycle.js";
import type { OrderItem, Parcel } from "../domain/parcel.js";
import { appendEvent, type EventBus } from "../events/bus.js";
import {
  groupBy,
  ParcelRepository,
  RAW_PRESENTATION,
  type Presentation,
} from "../parcels/repository.js";
import type { Return } from "../domain/return.js";
import type { ReturnService } from "../returns/service.js";

export interface OrderFilter {
  readonly view: OrderView;
  readonly limit: number;
  readonly offset: number;
}

export interface OrderPatch {
  readonly label?: string | null;
  /** True archives, false keeps it out of the archive, null returns to automatic archiving. */
  readonly archived?: boolean | null;
}

type OrderRow = Selectable<OrderTable>;

/** Orders per page when no limit is given. */
export const ORDER_PAGE_DEFAULT = 100;

interface OrderParts {
  readonly items: OrderItem[];
  readonly parcels: readonly Parcel[];
  readonly returns: Return[];
}

function toOrder(row: OrderRow, { items, parcels, returns }: OrderParts, now: Date): Order {
  const status = orderStatus(parcels);
  const archivedAt = orderArchivedAt(
    row.archive_mode,
    row.archived_at,
    parcels,
    row.placed_at ?? row.created_at,
    now,
  );
  return {
    id: row.id,
    shop: row.shop,
    order_number: row.order_number,
    label: row.label,
    display_name: row.label ?? `${row.shop} ${row.order_number}`,
    placed_at: row.placed_at,
    status,
    archived: archivedAt !== null,
    archived_at: archivedAt,
    archive_mode: row.archive_mode ?? "automatic",
    parcel_count: parcels.length,
    delivered_count: parcels.filter((parcel) => parcel.delivered).length,
    total: orderTotal(items),
    items,
    return_until: row.return_until,
    returns,
    parcels: parcels.map((parcel) => ({
      id: parcel.id,
      carrier: parcel.carrier,
      tracking_number: parcel.tracking_number,
      barcode: parcel.tracking_number,
      direction: parcel.direction,
      legacy_direction: parcel.legacy_direction,
      display_name: parcel.display_name,
      status: parcel.status,
      delivered: parcel.delivered,
      delivered_at: parcel.delivered_at,
      expected_from: parcel.expected_from,
      expected_to: parcel.expected_to,
      expected_days: parcel.expected_days,
      planned_from: parcel.expected_from,
      planned_to: parcel.expected_to,
      archived_at: parcel.archived_at,
      location: parcel.location,
      url: parcel.url,
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Orders as their own resource. Status and archiving are derived from the parcels on every read
 * (see `order-lifecycle.ts`), so they can never drift from what the parcels say.
 */
export class OrderService {
  readonly #parcels: ParcelRepository;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly presentation: Presentation = RAW_PRESENTATION,
    /** Embeds each order's returns; without it orders list none. */
    private readonly returns?: ReturnService,
  ) {
    this.#parcels = new ParcelRepository(db, presentation);
  }

  /**
   * Orders in the view, newest first; `more` says another page follows. The view is decided from
   * the orders' rows and their parcels' states alone (the same functions a built order uses), so
   * only the page's orders are built with their lines, parcels and returns.
   */
  async list(filter: OrderFilter): Promise<{ orders: Order[]; more: boolean }> {
    const [rows, states] = await Promise.all([
      this.db
        .selectFrom("orders")
        .selectAll()
        .where("deleted_at", "is", null)
        .where(orderVisible)
        .execute(),
      this.#parcels.statesByOrder(),
    ]);
    const now = this.clock.now();
    const shown = rows
      .filter((row) => {
        const parcels = states.get(row.id) ?? [];
        const archivedAt = orderArchivedAt(
          row.archive_mode,
          row.archived_at,
          parcels,
          row.placed_at ?? row.created_at,
          now,
        );
        return inView(filter.view, orderStatus(parcels), archivedAt !== null);
      })
      .sort((a, b) => newest(b).localeCompare(newest(a)) || a.id.localeCompare(b.id));
    return {
      orders: await this.#build(shown.slice(filter.offset, filter.offset + filter.limit)),
      more: shown.length > filter.offset + filter.limit,
    };
  }

  async get(id: string): Promise<Order | undefined> {
    const row = await this.db
      .selectFrom("orders")
      .selectAll()
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .where(orderVisible)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const [order] = await this.#build([row]);
    return order;
  }

  async update(id: string, patch: OrderPatch): Promise<Order | undefined> {
    if ((await this.get(id)) === undefined) return undefined;
    const now = isoNow(this.clock);
    await this.db
      .updateTable("orders")
      .set({
        updated_at: now,
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.archived === undefined
          ? {}
          : patch.archived === null
            ? { archive_mode: null, archived_at: null }
            : patch.archived
              ? { archive_mode: "archived", archived_at: now }
              : { archive_mode: "kept", archived_at: null }),
      })
      .where("id", "=", id)
      .execute();
    const after = await this.get(id);
    if (after === undefined) return undefined;
    await appendEvent(this.db, this.clock, {
      type: "order.updated",
      parcelId: null,
      payload: { ...after, parcels: [] },
    });
    await this.bus.notify();
    return after;
  }

  /**
   * Deletes the order but keeps its parcels, which lose the link. The row stays as a tombstone
   * (`deleted_at`), so a shop connection listing the order again does not bring it back: its parcels
   * are then tracked without an order.
   */
  async delete(id: string): Promise<boolean> {
    const order = await this.get(id);
    if (order === undefined) return false;
    const now = isoNow(this.clock);
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("order_items").where("order_id", "=", id).execute();
      await trx
        .updateTable("parcels")
        .set({ order_id: null, updated_at: now })
        .where("order_id", "=", id)
        .execute();
      await trx
        .updateTable("orders")
        .set({ deleted_at: now, updated_at: now })
        .where("id", "=", id)
        .execute();
      await appendEvent(trx, this.clock, {
        type: "order.deleted",
        parcelId: null,
        payload: { id, parcel_ids: order.parcels.map((parcel) => parcel.id) },
      });
    });
    await this.bus.notify();
    return true;
  }

  async #build(rows: readonly OrderRow[]): Promise<Order[]> {
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return [];
    const [lines, parcels, returns] = await Promise.all([
      this.db
        .selectFrom("order_items")
        .selectAll()
        .where("order_id", "in", ids)
        .orderBy("order_id")
        .orderBy("position")
        .execute(),
      this.#parcels.byOrders(ids),
      this.returns?.byOrders(ids) ?? Promise.resolve([]),
    ]);
    const now = this.clock.now();
    const linesOf = groupBy(lines, (line) => line.order_id);
    const parcelsOf = groupBy(parcels, (entry) => entry.orderId);
    const returnsOf = groupBy(returns, (entry) => entry.order_id);
    return rows.map((row) =>
      toOrder(
        row,
        {
          items: (linesOf.get(row.id) ?? []).map((line) => ({
            title: line.title,
            image_url: this.presentation.imagePath(line.image_ref),
            url: line.url,
            quantity: line.quantity,
            price: line.price,
            currency: line.currency,
            parcel_id: line.parcel_id,
          })),
          parcels: (parcelsOf.get(row.id) ?? []).map((entry) => entry.parcel),
          returns: returnsOf.get(row.id) ?? [],
        },
        now,
      ),
    );
  }
}

/** Sorted by when the order was placed, else when it was first seen. */
function newest(order: OrderRow): string {
  return order.placed_at ?? order.created_at;
}
