import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";

/** Folders under the data directory that only hold re-fetchable copies. */
export const CACHE_NAMES = ["images", "tiles", "collages"] as const;
export type CacheName = (typeof CACHE_NAMES)[number];

/** Counts and sizes for the Data page. */
export interface DataSummary {
  readonly parcels: number;
  readonly archived_parcels: number;
  readonly orders: number;
  readonly scans: number;
  readonly raw_payloads: number;
  readonly events: number;
  readonly database_bytes: number;
  readonly cache_bytes: Readonly<Record<CacheName, number>>;
}

async function count(db: Kysely<Database>, table: keyof Database): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .executeTakeFirst();
  return row?.n ?? 0;
}

async function fileBytes(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/** Total size of the files below `dir`; 0 when it does not exist. */
export async function directoryBytes(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return 0;
  }
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      try {
        const info = await stat(path.join(dir, entry));
        return info.isFile() ? info.size : 0;
      } catch {
        return 0;
      }
    }),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

export async function dataSummary(
  db: Kysely<Database>,
  dataDir: string,
  databasePath: string,
): Promise<DataSummary> {
  const archived = await db
    .selectFrom("parcels")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("archived_at", "is not", null)
    .executeTakeFirst();
  const orders = await db
    .selectFrom("orders")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  const caches = await Promise.all(
    CACHE_NAMES.map(
      async (name) => [name, await directoryBytes(path.join(dataDir, name))] as const,
    ),
  );
  return {
    parcels: await count(db, "parcels"),
    archived_parcels: archived?.n ?? 0,
    orders: orders?.n ?? 0,
    scans: await count(db, "parcel_events"),
    raw_payloads: await count(db, "parcel_raw"),
    events: await count(db, "outbox"),
    database_bytes: (await fileBytes(databasePath)) + (await fileBytes(`${databasePath}-wal`)),
    cache_bytes: Object.fromEntries(caches) as Record<CacheName, number>,
  };
}

/** Empties a cache folder; its contents are fetched again when needed. Returns bytes freed. */
export async function clearCache(dataDir: string, name: CacheName): Promise<number> {
  const dir = path.join(dataDir, name);
  const bytes = await directoryBytes(dir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return bytes;
}

/**
 * Writes a consistent copy of the database to `<dataDir>/backups/` and returns its path. Used
 * before deleting everything, so a mistaken reset can be undone by restoring the file.
 */
export async function backupDatabase(
  db: Kysely<Database>,
  dataDir: string,
  clock: Clock,
): Promise<string> {
  const dir = path.join(dataDir, "backups");
  await mkdir(dir, { recursive: true });
  const stamp = clock.now().toISOString().replaceAll(":", "-").replace(/\..*$/, "");
  const file = path.join(dir, `openparcels-${stamp}.db`);
  await sql`vacuum into ${sql.lit(file)}`.execute(db);
  return file;
}
