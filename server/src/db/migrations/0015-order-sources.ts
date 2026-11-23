import { sql, type Kysely } from "kysely";

/**
 * `order_sources` records which sources reported an order, as `parcel_sources` does for parcels,
 * so an order can be hidden while every source it came from is disabled.
 *
 * Existing orders are linked from the sources of their parcels; orders without parcels (a shop
 * listing an order before it ships) are linked to the shop or account source whose label or
 * plug-in is the order's shop. An order nothing matches stays unlinked, and unlinked orders always
 * show.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("order_sources")
    .addColumn("order_id", "text", (c) => c.notNull().references("orders.id").onDelete("cascade"))
    .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
    .addPrimaryKeyConstraint("order_sources_pk", ["order_id", "source_id"])
    .execute();
  await db.schema
    .createIndex("order_sources_source")
    .on("order_sources")
    .column("source_id")
    .execute();
  await sql`
    insert or ignore into order_sources (order_id, source_id)
    select distinct p.order_id, ps.source_id
    from parcels p join parcel_sources ps on ps.parcel_id = p.id
    where p.order_id is not null
  `.execute(db);
  await sql`
    insert or ignore into order_sources (order_id, source_id)
    select o.id, s.id
    from orders o join sources s
      on s.kind in ('shop', 'account') and (s.label = o.shop or s.plugin = o.shop)
    where not exists (select 1 from order_sources x where x.order_id = o.id)
  `.execute(db);
}
