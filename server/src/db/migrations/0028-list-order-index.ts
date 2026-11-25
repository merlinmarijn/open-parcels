import type { Kysely } from "kysely";

/**
 * The parcel list's sort order (newest change first, the id breaking ties) as an index, so a page
 * deep into 10,000 parcels walks the index instead of sorting every parcel (docs/performance.md).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("parcels_updated")
    .ifNotExists()
    .on("parcels")
    .columns(["updated_at desc", "id"])
    .execute();
}
