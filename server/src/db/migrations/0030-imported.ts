import type { Kysely } from "kysely";

/**
 * `imported_at` on parcels and orders: when a job (an "Import history" action) created them.
 * Imported history is not news (no notifications for it) and retention never deletes it. See
 * `docs/connection-actions-and-jobs.md` §6.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("parcels").addColumn("imported_at", "text").execute();
  await db.schema.alterTable("orders").addColumn("imported_at", "text").execute();
}
