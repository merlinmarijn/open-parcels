import type { Kysely } from "kysely";

/**
 * What an order costs as the shop's (or a payment service's) email states it. `total_source`
 * says who stated it: `shop` wins over `payment` (a PayPal receipt), which only fills a gap.
 * Without a stated total the order's total is still summed from its priced lines.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("orders").addColumn("total_amount", "real").execute();
  await db.schema.alterTable("orders").addColumn("total_currency", "text").execute();
  await db.schema.alterTable("orders").addColumn("total_source", "text").execute();
}
