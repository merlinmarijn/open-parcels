import type { Kysely } from "kysely";
import { inTransaction } from "../atomic.js";

/**
 * Token logins for clients without cookies (a web UI on another origin, the Android app, client
 * libraries): one row per login, holding the SHA-256 of its current access token and refresh
 * token. Refreshing replaces both; the refresh token it replaced is kept so a second use of it
 * (a stolen copy) ends the login. See decision record 0003 §6.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await inTransaction(db, async () => {
    await db.schema
      .createTable("logins")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("role", "text", (c) => c.notNull())
      .addColumn("access_hash", "text", (c) => c.notNull().unique())
      .addColumn("access_expires_at", "text", (c) => c.notNull())
      .addColumn("refresh_hash", "text", (c) => c.notNull().unique())
      .addColumn("previous_refresh_hash", "text")
      .addColumn("refresh_expires_at", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("last_used_at", "text", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("logins_previous_refresh")
      .on("logins")
      .column("previous_refresh_hash")
      .execute();
  });
}
