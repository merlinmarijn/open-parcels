import { sql, type Kysely } from "kysely";
import { inTransaction } from "../atomic.js";
import { createSyncTriggers } from "../sync-triggers.js";

/**
 * Delta sync (decision record 0004 §6, docs/sync.md): `sync_changes` holds the newest change of
 * every parcel, event, order, return and connection, and a tombstone for each deleted one, kept
 * by triggers (`db/sync-triggers.ts`). Events get the `updated_at` every other synced table has.
 * Every existing row is listed once, so the first sync of a client returns everything.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await inTransaction(db, async () => {
    await sql`
      create table sync_changes (
        seq integer primary key autoincrement,
        entity text not null,
        entity_id text not null,
        deleted integer not null,
        changed_at text not null
      )
    `.execute(db);
    await sql`create unique index sync_changes_entity on sync_changes (entity, entity_id)`.execute(
      db,
    );
    await db.schema.alterTable("parcel_events").addColumn("updated_at", "text").execute();
    await sql`update parcel_events set updated_at = at`.execute(db);
    const now = new Date().toISOString();
    for (const [entity, table, id] of [
      ["connection", "connections", "id"],
      ["order", "orders", "id"],
      ["parcel", "parcels", "id"],
      ["event", "parcel_events", "cast(id as text)"],
      ["return", "returns", "id"],
    ] as const) {
      await sql`
        insert into sync_changes (entity, entity_id, deleted, changed_at)
        select ${entity}, ${sql.raw(id)}, 0, ${now} from ${sql.table(table)} order by rowid
      `.execute(db);
    }
    await createSyncTriggers(db);
  });
}
