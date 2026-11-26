import type { Transaction } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import {
  asReportedOrderStatus,
  isDigitalShop,
  nextReportedStatus,
  type ReportedOrderStatus,
} from "../domain/order.js";
import type { Order } from "../domain/order-lifecycle.js";
import { appendEvent } from "../events/bus.js";
import type { OrderSnapshot } from "../provider/snapshot.js";
import { createOrder, findOrder, type OrderRow } from "./order-rows.js";

type Trx = Transaction<Database>;

export interface OrderEnv {
  readonly clock: Clock;
  /** The order as the API shows it, read inside the transaction; undefined when hidden. */
  readonly orderView: (trx: Trx, id: string) => Promise<Order | undefined>;
  /** Set while an import job's results are stored: the orders they start are imported. */
  readonly importedAt?: string | null;
}

/** A digital shop's order is delivered once it is placed: there is no parcel to wait for. */
function reportedStatus(shop: string, status: ReportedOrderStatus): ReportedOrderStatus {
  return status === "ordered" && isDigitalShop(shop) ? "delivered" : status;
}

/** An item title as emails shorten it, for comparing lines. */
function titleKey(title: string): string {
  return title
    .replace(/(?:\.{2,}|…)\s*$/u, "")
    .trim()
    .toLowerCase();
}

/** Adds the titles the order does not list yet; returns how many were added. */
async function addItems(trx: Trx, orderId: string, titles: readonly string[]): Promise<number> {
  if (titles.length === 0) return 0;
  const stored = await trx
    .selectFrom("order_items")
    .select(["title", "position"])
    .where("order_id", "=", orderId)
    .execute();
  const known = stored.map((item) => titleKey(item.title));
  let position = stored.reduce((max, item) => Math.max(max, item.position + 1), 0);
  let added = 0;
  for (const title of titles) {
    const key = titleKey(title);
    // "Some product…" in one email and "Some product, red" in another are one line.
    if (key === "" || known.some((other) => other.startsWith(key) || key.startsWith(other))) {
      continue;
    }
    known.push(key);
    await trx
      .insertInto("order_items")
      .values({
        order_id: orderId,
        position,
        title,
        image_ref: null,
        url: null,
        external_id: null,
        quantity: null,
        price: null,
        currency: null,
        parcel_id: null,
      })
      .execute();
    position += 1;
    added += 1;
  }
  return added;
}

/**
 * The total after a report: the shop's own stated total wins (its latest), a payment service's
 * only fills the gap until the shop states one.
 */
function totalAfter(row: OrderRow | undefined, report: OrderSnapshot) {
  const stored = {
    total_amount: row?.total_amount ?? null,
    total_currency: row?.total_currency ?? null,
    total_source: row?.total_source ?? null,
  };
  if (report.total === null || (report.payment && stored.total_source === "shop")) return stored;
  return {
    total_amount: report.total.amount,
    total_currency: report.total.currency,
    total_source: report.payment ? ("payment" as const) : ("shop" as const),
  };
}

/** The columns a report changes: the status moves on, the earliest report dates the order. */
function changes(row: OrderRow | undefined, shop: string, report: OrderSnapshot) {
  const stored = asReportedOrderStatus(row?.status ?? null);
  const status =
    report.status === null
      ? stored
      : nextReportedStatus(stored, reportedStatus(shop, report.status));
  const placedAt = row?.placed_at ?? null;
  const dated =
    report.at !== null &&
    (placedAt === null || (report.status === "ordered" && report.at < placedAt))
      ? report.at
      : placedAt;
  return { status, placed_at: dated, ...totalAfter(row, report) };
}

async function fire(
  trx: Trx,
  env: OrderEnv,
  id: string,
  type: "order.created" | "order.updated",
): Promise<number> {
  const order = await env.orderView(trx, id);
  if (order === undefined) return 0;
  await appendEvent(trx, env.clock, { type, parcelId: null, payload: { ...order, parcels: [] } });
  return 1;
}

/**
 * Stores one order report: finds the order by shop and order number (a payment receipt by the
 * shop's reference, see `findOrder`) or starts it, moves its reported status on, adds new items
 * and links the connection. Fires `order.created` or `order.updated` when anything changed.
 * A deleted order stays deleted.
 */
async function applyOrder(
  trx: Trx,
  env: OrderEnv,
  connectionId: string,
  report: OrderSnapshot,
): Promise<number> {
  const now = isoNow(env.clock);
  const row = await findOrder(trx, report.order);
  if (row !== undefined && row.deleted_at !== null) return 0;
  const shop = row?.shop ?? report.order.shop;
  const next = changes(row, shop, report);
  const id =
    row?.id ?? (await createOrder(trx, report.order, now, { importedAt: env.importedAt ?? null }));
  if (row === undefined) {
    await trx.updateTable("orders").set(next).where("id", "=", id).execute();
  }
  const changed =
    row !== undefined &&
    (Object.keys(next) as (keyof typeof next)[]).some((key) => row[key] !== next[key]);
  if (changed) {
    await trx
      .updateTable("orders")
      .set({ ...next, updated_at: now })
      .where("id", "=", id)
      .execute();
  }
  const added = await addItems(trx, id, report.items);
  await trx
    .insertInto("order_connections")
    .values({ order_id: id, connection_id: connectionId })
    .onConflict((oc) => oc.columns(["order_id", "connection_id"]).doNothing())
    .execute();
  if (row === undefined) return fire(trx, env, id, "order.created");
  if (!changed && added === 0) return 0;
  if (!changed) {
    await trx.updateTable("orders").set({ updated_at: now }).where("id", "=", id).execute();
  }
  return fire(trx, env, id, "order.updated");
}

/** Stores a run's order reports; returns how many live events fired. */
export async function applyOrders(
  trx: Trx,
  env: OrderEnv,
  connectionId: string,
  reports: readonly OrderSnapshot[],
): Promise<number> {
  let events = 0;
  for (const report of reports) {
    events += await applyOrder(trx, env, connectionId, report);
  }
  return events;
}

/**
 * Marks an order refunded when the money came back without a return to file it under (a
 * cancelled order, a digital purchase). Fires `order.updated` when that changed anything.
 */
export async function markRefunded(trx: Trx, env: OrderEnv, orderId: string): Promise<number> {
  const row = await trx
    .selectFrom("orders")
    .selectAll()
    .where("id", "=", orderId)
    .executeTakeFirst();
  if (row?.deleted_at !== null) return 0;
  const status = nextReportedStatus(asReportedOrderStatus(row.status), "refunded");
  if (status === row.status) return 0;
  await trx
    .updateTable("orders")
    .set({ status, updated_at: isoNow(env.clock) })
    .where("id", "=", orderId)
    .execute();
  return fire(trx, env, orderId, "order.updated");
}
