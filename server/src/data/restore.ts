import { copyFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import SQLite from "better-sqlite3";
import { DecryptionError, type SecretBox } from "../crypto/secrets.js";
import { MIGRATIONS } from "../db/database.js";
import { secretAad } from "../engine/connections.js";

/** A backup that cannot or must not be restored; the message says why and what to do. */
class RestoreError extends Error {
  override readonly name = "RestoreError";
}

interface BackupContents {
  readonly parcels: number;
  readonly orders: number;
  readonly connections: number;
  /** Database migrations the backup has; the rest run when the server starts on it. */
  readonly migrations: number;
  readonly pendingMigrations: number;
  /**
   * Whether this installation's encryption key opens the backup's stored sign-ins: false means
   * every connection must be signed in again; null when the backup holds none or there is no key.
   */
  readonly keyMatches: boolean | null;
}

export interface RestoreReport extends BackupContents {
  readonly backup: string;
  readonly dryRun: boolean;
  /** Where the database that was replaced now is; null on a dry run or when there was none. */
  readonly previous: string | null;
}

function countRows(sqlite: SQLite.Database, table: string): number {
  const row: unknown = sqlite.prepare(`select count(*) as n from ${table}`).get();
  return typeof row === "object" && row !== null && "n" in row && typeof row.n === "number"
    ? row.n
    : 0;
}

function keyMatches(sqlite: SQLite.Database, secrets: SecretBox | undefined): boolean | null {
  if (secrets === undefined) return null;
  const row: unknown = sqlite
    .prepare("select id, secret_blob from connections where secret_blob is not null limit 1")
    .get();
  if (typeof row !== "object" || row === null || !("id" in row) || !("secret_blob" in row)) {
    return null;
  }
  const { id, secret_blob: blob } = row;
  if (typeof id !== "string" || !Buffer.isBuffer(blob)) return null;
  try {
    secrets.decryptJson(blob, secretAad(id));
    return true;
  } catch (error) {
    if (error instanceof DecryptionError) return false;
    throw error;
  }
}

/**
 * Opens a backup read-only and checks that it can be restored: SQLite's integrity check passes, it
 * is an open-parcels database, and no migration in it is unknown to this version (a backup of a
 * newer version would be downgraded silently otherwise).
 */
function inspectBackup(file: string, secrets?: SecretBox): BackupContents {
  if (!existsSync(file)) {
    throw new RestoreError(`There is no file at ${file}.`);
  }
  let sqlite: SQLite.Database;
  try {
    sqlite = new SQLite(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new RestoreError(`${file} cannot be opened as a database.`, { cause: error });
  }
  try {
    let integrity: unknown;
    try {
      integrity = sqlite.pragma("integrity_check", { simple: true });
    } catch (error) {
      throw new RestoreError(`${file} is not a database.`, { cause: error });
    }
    if (integrity !== "ok") {
      throw new RestoreError(`${file} is damaged: SQLite's integrity check failed.`);
    }
    const hasMigrations =
      sqlite
        .prepare("select 1 from sqlite_master where type = 'table' and name = 'kysely_migration'")
        .get() !== undefined;
    if (!hasMigrations) {
      throw new RestoreError(`${file} is not an open-parcels database.`);
    }
    const names = sqlite
      .prepare("select name from kysely_migration")
      .pluck()
      .all()
      .filter((name): name is string => typeof name === "string");
    const unknown = names.find((name) => !Object.hasOwn(MIGRATIONS, name));
    if (unknown !== undefined) {
      throw new RestoreError(
        `${file} was written by a newer open-parcels version (it has migration ${unknown}). Update open-parcels first, then restore.`,
      );
    }
    return {
      parcels: countRows(sqlite, "parcels"),
      orders: countRows(sqlite, "orders"),
      connections: countRows(sqlite, "connections"),
      migrations: names.length,
      pendingMigrations: Object.keys(MIGRATIONS).length - names.length,
      keyMatches: keyMatches(sqlite, secrets),
    };
  } finally {
    sqlite.close();
  }
}

export interface RestoreOptions {
  readonly backup: string;
  readonly databasePath: string;
  readonly now: Date;
  readonly dryRun: boolean;
  /** Restore although the database looks open (a `-wal` file left by a server that crashed). */
  readonly force: boolean;
  readonly secrets?: SecretBox | undefined;
}

/**
 * Puts a backup in place of the database. The server must be stopped: a running server keeps a
 * `-wal` file next to the database, and the restore refuses while one exists unless forced. The
 * database it replaces is kept beside it as `<name>.before-restore-<time>` (with its `-wal` and
 * `-shm` files when forced), and the backup is copied, never moved, so it stays in the backup
 * folder. Migrations the backup lacks run when the server starts.
 */
export function restoreBackup(options: RestoreOptions): RestoreReport {
  const backup = path.resolve(options.backup);
  const target = path.resolve(options.databasePath);
  if (backup === target) {
    throw new RestoreError("That is the database itself; name a backup file.");
  }
  const contents = inspectBackup(backup, options.secrets);
  if (existsSync(`${target}-wal`) && !options.force) {
    throw new RestoreError(
      "open-parcels looks like it is running (the database has a -wal file next to it). Stop it first. If it is stopped and was not shut down cleanly, run again with --force.",
    );
  }
  if (options.dryRun) {
    return { ...contents, backup, dryRun: true, previous: null };
  }
  const stamp = options.now.toISOString().replaceAll(":", "-").replace(/\..*$/, "");
  let previous: string | null = null;
  if (existsSync(target)) {
    previous = `${target}.before-restore-${stamp}`;
    renameSync(target, previous);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${target}${suffix}`)) {
        renameSync(`${target}${suffix}`, `${previous}${suffix}`);
      }
    }
  }
  const incoming = `${target}.restoring`;
  copyFileSync(backup, incoming);
  renameSync(incoming, target);
  return { ...contents, backup, dryRun: false, previous };
}
