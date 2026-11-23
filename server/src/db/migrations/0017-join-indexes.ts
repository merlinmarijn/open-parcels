import type { Kysely } from "kysely";

/**
 * Indexes for columns used in joins and filters that had none: a parcel's order (order views and
 * counts), an order line's parcel, a scan's source (clean-up per source) and the code alone (the
 * hand-off and twin searches look a code up across carriers; the unique index starts with the
 * carrier). Each statement is safe on its own, so a half-run migration can simply run again.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("parcels_order")
    .ifNotExists()
    .on("parcels")
    .column("order_id")
    .execute();
  await db.schema
    .createIndex("order_items_parcel")
    .ifNotExists()
    .on("order_items")
    .column("parcel_id")
    .execute();
  await db.schema
    .createIndex("parcel_events_source")
    .ifNotExists()
    .on("parcel_events")
    .column("source_id")
    .execute();
  await db.schema
    .createIndex("parcels_barcode")
    .ifNotExists()
    .on("parcels")
    .column("barcode")
    .execute();
}
