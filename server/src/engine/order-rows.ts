import type { Selectable, Transaction } from "kysely";
import type { Database, OrderTable } from "../db/schema.js";
import { PAYMENT_SHOPS } from "../domain/order.js";

type Trx = Transaction<Database>;
export type OrderRow = Selectable<OrderTable>;

export interface OrderKey {
  readonly shop: string;
  readonly orderNumber: string;
}

/**
 * The stored order a report is about, deleted ones included (callers decide what a tombstone
 * means). Orders merge by shop and order number, with one exception for payment receipts
 * (`PAYMENT_SHOPS`), which quote the shop's reference without naming the shop:
 * - a receipt joins the one shop's order with that number; with none (or several, which cannot be
 *   told apart) it keeps a stand-in order under the payment service;
 * - a shop's report finding no order of its own adopts such a stand-in, which becomes the shop's
 *   order with everything linked to it.
 */
export async function findOrder(trx: Trx, key: OrderKey): Promise<OrderRow | undefined> {
  if (PAYMENT_SHOPS.has(key.shop)) {
    const rows = await trx
      .selectFrom("orders")
      .selectAll()
      .where("order_number", "=", key.orderNumber)
      .execute();
    const shops = rows.filter((row) => !PAYMENT_SHOPS.has(row.shop));
    return (shops.length === 1 ? shops[0] : undefined) ?? rows.find((row) => row.shop === key.shop);
  }
  const exact = await trx
    .selectFrom("orders")
    .selectAll()
    .where("shop", "=", key.shop)
    .where("order_number", "=", key.orderNumber)
    .executeTakeFirst();
  if (exact !== undefined) return exact;
  const standIn = await trx
    .selectFrom("orders")
    .selectAll()
    .where("shop", "in", [...PAYMENT_SHOPS])
    .where("order_number", "=", key.orderNumber)
    .where("deleted_at", "is", null)
    .orderBy("created_at")
    .executeTakeFirst();
  if (standIn === undefined) return undefined;
  await trx.updateTable("orders").set({ shop: key.shop }).where("id", "=", standIn.id).execute();
  return { ...standIn, shop: key.shop };
}

/** Stores a new order and returns its id. */
export async function createOrder(
  trx: Trx,
  key: OrderKey,
  now: string,
  values: { readonly placedAt?: string | null; readonly returnUntil?: string | null } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await trx
    .insertInto("orders")
    .values({
      id,
      shop: key.shop,
      order_number: key.orderNumber,
      placed_at: values.placedAt ?? null,
      return_until: values.returnUntil ?? null,
      status: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}
