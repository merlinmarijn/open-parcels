import { sql, type Kysely } from "kysely";

/**
 * Runs a multi-statement migration as one transaction. Kysely runs SQLite migrations outside a
 * transaction, so without this a crash midway leaves a half-applied schema the next start cannot
 * repeat ("table already exists").
 */
export async function inTransaction<DB>(db: Kysely<DB>, work: () => Promise<void>): Promise<void> {
  await sql`begin`.execute(db);
  try {
    await work();
    await sql`commit`.execute(db);
  } catch (error) {
    await sql`rollback`.execute(db);
    throw error;
  }
}
