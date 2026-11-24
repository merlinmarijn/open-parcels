import type { Kysely } from "kysely";

/**
 * Returns: what the owner sends back to a shop, per order.
 *
 * - `returns` holds one row per return. `external_ref` is the shop's own id when it gives one.
 *   `drop_off` is a JSON list of `{carrier, kind, description}`. `parcel_id` is the outgoing
 *   parcel that tracks the return once its tracking number is known; it is unset, not deleted,
 *   when that parcel goes.
 * - `return_sources` records which sources reported a return, as `order_sources` does for orders,
 *   so a return hides while every source it came from is disabled.
 * - `return_items` names what goes back, linked to the order's line when the titles agree.
 * - `orders.return_until`: the last day of the order's return window, as the shop lists it, before
 *   any return was asked for.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("returns")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("order_id", "text", (c) => c.notNull().references("orders.id").onDelete("cascade"))
    .addColumn("external_ref", "text")
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("reason", "text")
    .addColumn("return_by", "text")
    .addColumn("drop_off", "text", (c) => c.notNull().defaultTo("[]"))
    .addColumn("cost_free", "integer")
    .addColumn("cost_amount", "real")
    .addColumn("cost_currency", "text")
    .addColumn("label_url", "text")
    .addColumn("carrier", "text")
    .addColumn("tracking_number", "text")
    .addColumn("parcel_id", "text", (c) => c.references("parcels.id").onDelete("set null"))
    .addColumn("refund_amount", "real")
    .addColumn("refund_currency", "text")
    .addColumn("refund_status", "text")
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("returns_order")
    .on("returns")
    .columns(["order_id", "external_ref"])
    .execute();
  await db.schema.createIndex("returns_parcel").on("returns").column("parcel_id").execute();
  await db.schema
    .createTable("return_sources")
    .addColumn("return_id", "text", (c) => c.notNull().references("returns.id").onDelete("cascade"))
    .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
    .addPrimaryKeyConstraint("return_sources_pk", ["return_id", "source_id"])
    .execute();
  await db.schema
    .createIndex("return_sources_source")
    .on("return_sources")
    .column("source_id")
    .execute();
  await db.schema
    .createTable("return_items")
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("return_id", "text", (c) => c.notNull().references("returns.id").onDelete("cascade"))
    .addColumn("position", "integer", (c) => c.notNull())
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("order_item_id", "integer", (c) =>
      c.references("order_items.id").onDelete("set null"),
    )
    .execute();
  await db.schema
    .createIndex("return_items_return")
    .on("return_items")
    .columns(["return_id", "position"])
    .execute();
  await db.schema.alterTable("orders").addColumn("return_until", "text").execute();
}
