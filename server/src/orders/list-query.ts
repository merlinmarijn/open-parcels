import { sql, type Kysely, type RawBuilder } from "kysely";
import type { Database } from "../db/schema.js";
import { orderVisible, parcelVisible } from "../db/visibility.js";
import { PARCELLESS_ARCHIVE_DAYS, type OrderView } from "../domain/order-lifecycle.js";

/**
 * The order list's page in one SQL query: each order's status and whether it is archived, derived
 * from its visible parcels exactly as `orderStatus` and `orderArchivedAt` derive them
 * (`order-lifecycle.ts`; a test holds the two to the same answers), then filtered by view, sorted
 * newest first and paged. Nothing is stored, so it cannot drift from the parcels; the database
 * reads the parcels' states once per request instead of handing every order to JavaScript.
 */
export async function orderPage(
  db: Kysely<Database>,
  page: { readonly view: OrderView; readonly limit: number; readonly offset: number },
  now: Date,
): Promise<{ readonly ids: string[]; readonly more: boolean }> {
  // The parcels' effective states: a manual status wins over the carrier's (`effectiveStatus`).
  const status = sql<string>`coalesce(parcels.manual_status, parcels.status)`;
  const delivered = sql<number>`(case when parcels.manual_status is null then parcels.delivered
    else parcels.manual_status = 'delivered' end)`;
  const parcels = db
    .selectFrom("parcels")
    .where("parcels.order_id", "is not", null)
    .where(parcelVisible)
    .select([
      "parcels.order_id",
      sql<number>`count(*)`.as("total"),
      sql<number>`sum(${delivered})`.as("delivered"),
      sql<number>`sum(${status} not in ('registered', 'unknown'))`.as("shipped"),
      sql<number>`sum(not ${delivered} and ${status} in ('problem', 'returning'))`.as("trouble"),
      sql<number>`sum(parcels.archived_at is null)`.as("unarchived"),
    ])
    .groupBy("parcels.order_id");

  const total = sql<number>`coalesce(p.total, 0)`;
  const derived: RawBuilder<string> = sql`case
    when orders.status = 'refunded' then 'refunded'
    when orders.status = 'cancelled' and coalesce(p.delivered, 0) = 0 then 'cancelled'
    when ${total} = 0 then
      case when orders.status in ('shipped', 'delivered') then orders.status else 'ordered' end
    when p.trouble > 0 then 'problem'
    when p.delivered = p.total then 'delivered'
    when p.delivered > 0 then 'partly_delivered'
    when p.shipped = p.total then 'shipped'
    when p.shipped > 0 then 'partly_shipped'
    else 'ordered' end`;
  const parcellessDue = new Date(
    now.getTime() - PARCELLESS_ARCHIVE_DAYS * 86_400_000,
  ).toISOString();
  const archived: RawBuilder<number> = sql`case
    when orders.archive_mode = 'archived' then orders.archived_at is not null
    when orders.archive_mode = 'kept' then 0
    when (${derived}) in ('cancelled', 'refunded') then 1
    when ${total} = 0 then coalesce(orders.placed_at, orders.created_at) <= ${parcellessDue}
    else p.unarchived = 0 end`;

  const rows = await db
    .selectFrom("orders")
    .leftJoin(parcels.as("p"), "p.order_id", "orders.id")
    .where("orders.deleted_at", "is", null)
    .where(orderVisible)
    .where(() => inView(page.view, derived, archived))
    .select("orders.id")
    .orderBy(sql`coalesce(orders.placed_at, orders.created_at)`, "desc")
    .orderBy("orders.id")
    .limit(page.limit + 1)
    .offset(page.offset)
    .execute();
  return {
    ids: rows.slice(0, page.limit).map((row) => row.id),
    more: rows.length > page.limit,
  };
}

/** `inView` of `order-lifecycle.ts` as a condition. */
function inView(
  view: OrderView,
  status: RawBuilder<string>,
  archived: RawBuilder<number>,
): RawBuilder<boolean> {
  switch (view) {
    case "all":
      return sql<boolean>`1`;
    case "archived":
      return sql<boolean>`(${archived}) = 1`;
    case "delivered":
      return sql<boolean>`(${archived}) = 0 and (${status}) = 'delivered'`;
    case "open":
      return sql<boolean>`(${archived}) = 0 and (${status}) != 'delivered'`;
  }
}
