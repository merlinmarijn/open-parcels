import { sql, type Kysely } from "kysely";

/**
 * Home Assistant import markers (`settings` keys `ha_import:<entry>`) written before 2.0.0-dev name
 * the connection `sourceId`; they now say `connectionId`, so the importer reads one shape only.
 * Markers that are not JSON objects are left alone: the importer treats them as new entries.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const rows = await sql<{ key: string; value: string }>`
    select key, value from settings where key like 'ha_import:%'
  `.execute(db);
  for (const row of rows.rows) {
    let stored: unknown;
    try {
      stored = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (
      typeof stored !== "object" ||
      stored === null ||
      Array.isArray(stored) ||
      "connectionId" in stored ||
      !("sourceId" in stored)
    ) {
      continue;
    }
    const { sourceId, ...rest } = stored as Record<string, unknown>;
    const value = JSON.stringify({ ...rest, connectionId: sourceId });
    await sql`update settings set value = ${value} where key = ${row.key}`.execute(db);
  }
}
