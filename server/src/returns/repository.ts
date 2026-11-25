import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.js";
import { returnVisible } from "../db/visibility.js";
import {
  asReturnStatus,
  dropOffOptionSchema,
  presentedStatus,
  type DropOffOption,
  type Return,
} from "../domain/return.js";
import { localParts } from "../engine/tz.js";

type Db = Kysely<Database> | Transaction<Database>;

export interface ReturnQuery {
  readonly ids?: readonly string[];
  readonly orderIds?: readonly string[];
}

/** The server's local day, `YYYY-MM-DD`: what return-by dates are compared with. */
export function localDay(now: Date, timeZone: string): string {
  const { year, month, day } = localParts(now, timeZone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The stored drop-off list; anything malformed reads as no options rather than failing a read. */
function parseDropOff(value: string): DropOffOption[] {
  try {
    const parsed = dropOffOptionSchema.array().safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Returns as the API shows them, newest first, only those that show (their order shows and not
 * every connection they came from is disabled). `today` decides which ones read `expired`.
 */
export async function loadReturns(db: Db, query: ReturnQuery, today: string): Promise<Return[]> {
  if (query.ids?.length === 0 || query.orderIds?.length === 0) return [];
  let select = db
    .selectFrom("returns")
    .innerJoin("orders", "orders.id", "returns.order_id")
    .selectAll("returns")
    .select(["orders.shop", "orders.order_number"])
    .where(returnVisible);
  if (query.ids !== undefined) select = select.where("returns.id", "in", query.ids);
  if (query.orderIds !== undefined) select = select.where("returns.order_id", "in", query.orderIds);
  const rows = await select.orderBy("returns.created_at", "desc").orderBy("returns.id").execute();
  if (rows.length === 0) return [];
  const items = await db
    .selectFrom("return_items")
    .leftJoin("order_items", "order_items.id", "return_items.order_item_id")
    .select(["return_items.return_id", "return_items.title", "order_items.position"])
    .where(
      "return_items.return_id",
      "in",
      rows.map((row) => row.id),
    )
    .orderBy("return_items.return_id")
    .orderBy("return_items.position")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    order_id: row.order_id,
    shop: row.shop,
    order_number: row.order_number,
    status: presentedStatus(asReturnStatus(row.status) ?? "requested", row.return_by, today),
    reason: row.reason,
    return_by: row.return_by,
    drop_off: parseDropOff(row.drop_off),
    cost:
      row.cost_free === null
        ? null
        : { free: row.cost_free === 1, amount: row.cost_amount, currency: row.cost_currency },
    label_url: row.label_url,
    carrier: row.carrier,
    tracking_number: row.tracking_number,
    parcel_id: row.parcel_id,
    refund:
      row.refund_status === null
        ? null
        : { amount: row.refund_amount, currency: row.refund_currency, status: row.refund_status },
    items: items
      .filter((item) => item.return_id === row.id)
      .map((item) => ({ title: item.title, order_item_position: item.position ?? null })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}
