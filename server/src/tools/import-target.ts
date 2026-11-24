import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import SQLite from "better-sqlite3";
import type { Kysely } from "kysely";
import { loadConfig } from "../config.js";
import { loadSecretKey, SecretBox } from "../crypto/secrets.js";
import { migrateToLatest, openDatabase } from "../db/database.js";
import type { Database } from "../db/schema.js";

/** The import tools' command line: one input and `--dry-run`. Anything else is refused. */
export function parseImportArgs(
  argv: readonly string[],
  usage: string,
): { readonly input: string; readonly dryRun: boolean } {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { "dry-run": { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  const [input] = positionals;
  if (input === undefined || positionals.length !== 1) {
    throw new Error(usage);
  }
  return { input, dryRun: values["dry-run"] === true };
}

/**
 * Runs an import against this installation's database. A dry run changes nothing at all: it works
 * on a temporary copy of the database (migrated there, never in place) and needs the existing
 * encryption key instead of creating one.
 */
export async function withImportTarget<T>(
  dryRun: boolean,
  work: (db: Kysely<Database>, secrets: SecretBox) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  const { key } = loadSecretKey(config.secretKey, config.dataDir, { create: !dryRun });
  const scratch = dryRun ? mkdtempSync(path.join(tmpdir(), "open-parcels-dry-run-")) : undefined;
  try {
    const file = scratch === undefined ? config.databasePath : path.join(scratch, "copy.db");
    if (scratch !== undefined && existsSync(config.databasePath)) {
      const live = new SQLite(config.databasePath, { readonly: true, fileMustExist: true });
      try {
        await live.backup(file);
      } finally {
        live.close();
      }
    }
    const { db } = openDatabase(file);
    try {
      await migrateToLatest(db);
      return await work(db, new SecretBox(key));
    } finally {
      await db.destroy();
    }
  } finally {
    if (scratch !== undefined) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** Printed after a real import: the server reads connections and inboxes when it starts. */
export const RESTART_NOTICE =
  "Imported. Restart open-parcels if it is running, so it picks up the new connections and inboxes.\n";
