import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import SQLite from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { demoShop } from "../../src/carriers/demo_shop/index.js";
import { migrateToLatest, openDatabase } from "../../src/db/database.js";
import { registerBuiltin } from "../manifests.js";
import { main as restore } from "../../src/tools/restore-backup.js";
import { createTestContext } from "../helpers.js";

let dir: string;
let backupDir: string;
let database: string;
let output: { out: Mock<(text: string) => void>; err: Mock<(text: string) => void> };

/** A backup of a database with parcels, taken by the server's own backup service. */
async function makeBackup(): Promise<string> {
  const context = await createTestContext({ providers: [registerBuiltin(demoShop)] });
  try {
    const connection = await context.services.connections.create({
      provider: "demo_shop",
      kind: "shop",
      label: "Demo shop",
      config: {},
      secret: null,
    });
    await context.services.runner.run(connection.id);
    const result = await context.services.backups.run("manual");
    const file = path.join(backupDir, result.file ?? "missing.db");
    copyFileSync(path.join(context.dataDir, "backups", result.file ?? ""), file);
    return file;
  } finally {
    await context.close();
  }
}

/** The installation being restored into: an empty, migrated database, closed like a stopped server. */
async function emptyInstall(): Promise<void> {
  const { db } = openDatabase(database);
  await migrateToLatest(db);
  await db.destroy();
}

/** Read-write, like the server: a read-only connection would leave a `-wal` file behind. */
function parcelCount(file: string): unknown {
  const sqlite = new SQLite(file);
  try {
    return sqlite.prepare("select count(*) from parcels").pluck().get();
  } finally {
    sqlite.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "open-parcels-restore-"));
  backupDir = path.join(dir, "backups");
  database = path.join(dir, "openparcels.db");
  mkdirSync(backupDir);
  output = { out: vi.fn(), err: vi.fn() };
  vi.stubEnv("OPENPARCELS_DATA_DIR", dir);
  vi.stubEnv("OPENPARCELS_SECRET_KEY", undefined);
  vi.stubEnv("OPENPARCELS_BACKUP_DIR", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const printed = (fn: Mock<(text: string) => void>): string => fn.mock.calls.flat().join("");

describe("restore-backup", () => {
  it("puts the backup in place and keeps the replaced database", async () => {
    const backup = await makeBackup();
    await emptyInstall();
    expect(parcelCount(database)).toBe(0);

    // A bare file name is looked up in the backup folder.
    await restore([path.basename(backup)], output);

    expect(parcelCount(database)).toBeGreaterThan(0);
    expect(existsSync(backup)).toBe(true);
    const report = JSON.parse(printed(output.out)) as { previous: string; parcels: number };
    expect(report.parcels).toBeGreaterThan(0);
    expect(parcelCount(report.previous)).toBe(0);
    expect(printed(output.err)).toContain("Start open-parcels again");
  });

  it("changes nothing on a dry run", async () => {
    const backup = await makeBackup();
    await emptyInstall();
    await restore([backup, "--dry-run"], output);
    expect(parcelCount(database)).toBe(0);
    expect(readdirSync(dir).filter((name) => name.includes("before-restore"))).toEqual([]);
    expect(JSON.parse(printed(output.out))).toMatchObject({ dryRun: true, previous: null });
  });

  it("refuses while the server has the database open, unless forced", async () => {
    const backup = await makeBackup();
    const { db } = openDatabase(database);
    await migrateToLatest(db);
    try {
      expect(existsSync(`${database}-wal`)).toBe(true);
      await expect(restore([backup], output)).rejects.toThrow(/looks like it is running/);
      expect(parcelCount(database)).toBe(0);
    } finally {
      await db.destroy();
    }
    writeFileSync(`${database}-wal`, "");
    await restore([backup, "--force"], output);
    expect(parcelCount(database)).toBeGreaterThan(0);
  });

  it("refuses a backup of a newer version", async () => {
    const backup = await makeBackup();
    const writable = new SQLite(backup);
    writable
      .prepare("insert into kysely_migration (name, timestamp) values (?, ?)")
      .run("9999-from-the-future", new Date().toISOString());
    writable.close();
    await emptyInstall();
    await expect(restore([backup], output)).rejects.toThrow(/newer open-parcels version/);
    expect(parcelCount(database)).toBe(0);
  });

  it("refuses a file that is not an open-parcels database", async () => {
    const junk = path.join(dir, "junk.db");
    writeFileSync(junk, "this is not sqlite at all, just text that is long enough to read");
    await expect(restore([junk], output)).rejects.toThrow(/not a database|cannot be opened/);
    const other = path.join(dir, "other.db");
    const sqlite = new SQLite(other);
    sqlite.exec("create table notes (text)");
    sqlite.close();
    await expect(restore([other], output)).rejects.toThrow(/not an open-parcels database/);
  });

  it("refuses to restore the database onto itself", async () => {
    await emptyInstall();
    await expect(restore([database], output)).rejects.toThrow(/database itself/);
  });
});
