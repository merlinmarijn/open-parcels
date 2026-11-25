import { sql, type Kysely } from "kysely";

const KEY = "OPENPARCELS_GEOCODING";
/** Tables that hold rows in any install that has been used; all empty in a new database. */
const USED_TABLES = ["owner", "settings", "setting_overrides", "connections", "parcels"] as const;

/**
 * The background place lookup (OPENPARCELS_GEOCODING) is off by default from now on (OP-079).
 * An install that already ran with it on by default keeps it on: its effective value is saved as
 * a Settings page value, which can be reset or switched there like any other. Nothing is saved
 * when the environment sets the variable (that value still applies), when a value was saved in
 * the UI already, or for a new, empty database.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (process.env[KEY] !== undefined) return;
  const saved = await sql<{ n: number }>`
    select count(*) as n from setting_overrides where key = ${KEY}
  `.execute(db);
  if ((saved.rows[0]?.n ?? 0) > 0) return;
  if (!(await isUsedInstall(db))) return;
  await sql`
    insert into setting_overrides (key, value, updated_at)
    values (${KEY}, 'true', ${new Date().toISOString()})
  `.execute(db);
}

async function isUsedInstall(db: Kysely<unknown>): Promise<boolean> {
  for (const table of USED_TABLES) {
    const result = await sql<{ n: number }>`
      select exists (select 1 from ${sql.table(table)}) as n
    `.execute(db);
    if ((result.rows[0]?.n ?? 0) > 0) return true;
  }
  return false;
}
