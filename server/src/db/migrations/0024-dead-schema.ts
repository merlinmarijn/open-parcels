import type { Kysely } from "kysely";
import { inTransaction } from "../atomic.js";

/**
 * Drops schema nothing reads (OP-058): the `image_cache` table (pictures are cached on disk),
 * `parcels.dimensions` (never stored) and `parcels.manual_until` (only ever copied; `manual_at`
 * records the owner's override).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await inTransaction(db, async () => {
    await db.schema.dropTable("image_cache").execute();
    await db.schema.alterTable("parcels").dropColumn("dimensions").execute();
    await db.schema.alterTable("parcels").dropColumn("manual_until").execute();
  });
}
