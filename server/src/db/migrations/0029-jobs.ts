import type { Kysely } from "kysely";
import { inTransaction } from "../atomic.js";

/**
 * Jobs: the long-running, resumable work a connection's task action starts, with its state,
 * progress, encrypted checkpoint and summary. Deleted with the connection. See
 * `docs/connection-actions-and-jobs.md` §3.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await inTransaction(db, async () => {
    await db.schema
      .createTable("jobs")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("connection_id", "text", (c) =>
        c.notNull().references("connections.id").onDelete("cascade"),
      )
      .addColumn("provider", "text", (c) => c.notNull())
      .addColumn("action", "text", (c) => c.notNull())
      .addColumn("input", "text", (c) => c.notNull())
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("reason", "text")
      .addColumn("progress", "text", (c) => c.notNull())
      .addColumn("checkpoint_blob", "blob")
      .addColumn("summary", "text")
      .addColumn("retries", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("started_at", "text")
      .addColumn("updated_at", "text", (c) => c.notNull())
      .addColumn("finished_at", "text")
      .addColumn("resume_at", "text")
      .execute();
    await db.schema
      .createIndex("jobs_connection")
      .on("jobs")
      .columns(["connection_id", "created_at"])
      .execute();
    await db.schema.createIndex("jobs_state").on("jobs").column("state").execute();
  });
}
