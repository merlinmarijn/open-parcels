import { sql, type Kysely } from "kysely";
import { inTransaction } from "../atomic.js";

/**
 * A stored courier-map session names the connection that follows it, so after a restart only that
 * connection's first run may end it, not the first run of any other connection of the parcel.
 * Stored sessions cannot be assigned to a connection after the fact and are dropped; the owning
 * connection's next full poll starts a running session again.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await inTransaction(db, async () => {
    await recreate(db);
  });
}

async function recreate(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("live_state").execute();
  await db.schema
    .createTable("live_state")
    .addColumn("parcel_id", "text", (c) =>
      c.primaryKey().references("parcels.id").onDelete("cascade"),
    )
    .addColumn("connection_id", "text", (c) =>
      c.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("state", "text", (c) =>
      c.notNull().check(sql`state in ('en_route', 'next_stop', 'delivered', 'ended')`),
    )
    .addColumn("stops_away", "integer")
    .addColumn("message", "text")
    .addColumn("position_at", "text")
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();
}
