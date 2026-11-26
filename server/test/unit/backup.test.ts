import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import SQLite from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { demoShop } from "../../src/carriers/demo_shop/index.js";
import { listBackups, secureBackups } from "../../src/data/backup.js";
import { registerBuiltin } from "../manifests.js";
import { createTestContext, type TestContext } from "../helpers.js";

const HOUR = 60 * 60 * 1000;

let context: TestContext | undefined;
const scratch: string[] = [];
afterEach(async () => {
  await context?.close();
  context = undefined;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(env: Record<string, string> = {}): Promise<TestContext> {
  context = await createTestContext({ providers: [registerBuiltin(demoShop)], env });
  const connection = await context.services.connections.create({
    provider: "demo_shop",
    kind: "shop",
    label: "Demo shop",
    config: {},
    secret: null,
  });
  await context.services.runner.run(connection.id);
  return context;
}

async function backupEvents(test: TestContext): Promise<unknown[]> {
  const rows = await test.services.db
    .selectFrom("outbox")
    .select("payload")
    .where("type", "=", "backup.finished")
    .orderBy("seq")
    .execute();
  return rows.map((row) => JSON.parse(row.payload) as unknown);
}

describe("database backups", () => {
  it("writes a complete copy into backups/ in the data folder and announces it", async () => {
    const test = await start();
    const result = await test.services.backups.run("manual");
    expect(result).toMatchObject({ ok: true, reason: "manual", error: null, pruned: 0 });
    const file = path.join(test.dataDir, "backups", result.file ?? "");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.partial`)).toBe(false);

    const copy = new SQLite(file, { readonly: true });
    const parcels = copy.prepare("select count(*) from parcels").pluck().get();
    copy.close();
    const live = await test.services.db
      .selectFrom("parcels")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();
    expect(live.n).toBeGreaterThan(0);
    expect(parcels).toBe(live.n);

    expect(await backupEvents(test)).toEqual([result]);
    const status = await test.services.backups.status();
    expect(status.last).toEqual(result);
    expect(status.failing).toBe(false);
    expect(status.files.map((entry) => entry.name)).toEqual([result.file]);
  });

  it("keeps only the configured number of backups, deleting the oldest", async () => {
    const test = await start({ OPENPARCELS_BACKUP_KEEP: "2" });
    const names: (string | null)[] = [];
    for (let run = 0; run < 3; run += 1) {
      names.push((await test.services.backups.run("manual")).file);
      test.clock.advance(1000);
    }
    const kept = await listBackups(path.join(test.dataDir, "backups"));
    expect(kept.map((entry) => entry.name)).toEqual([names[2], names[1]]);
  });

  // Windows has no POSIX modes; the image and the NAS run Linux.
  const posix = process.platform !== "win32";
  const mode = (file: string): number => statSync(file).mode & 0o777;

  it.skipIf(!posix)("writes backups readable only by the server's user", async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), "open-parcels-backups-"));
    scratch.push(elsewhere);
    chmodSync(elsewhere, 0o755);
    const test = await start({ OPENPARCELS_BACKUP_DIR: elsewhere });
    const result = await test.services.backups.run("manual");
    expect(mode(path.join(elsewhere, result.file ?? ""))).toBe(0o600);
    expect(mode(elsewhere)).toBe(0o700);
  });

  it.skipIf(!posix)("restricts backups written before, leaving other files alone", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "open-parcels-backups-"));
    scratch.push(dir);
    chmodSync(dir, 0o755);
    const backup = path.join(dir, "openparcels-2026-11-25T10-00-00-000Z.db");
    const partial = `${backup}.partial`;
    const other = path.join(dir, "notes.txt");
    for (const file of [backup, partial, other]) writeFileSync(file, "x", { mode: 0o644 });
    await secureBackups(dir);
    expect([mode(dir), mode(backup), mode(partial), mode(other)]).toEqual([
      0o700, 0o600, 0o600, 0o644,
    ]);
    await expect(secureBackups(path.join(dir, "missing"))).resolves.toBeUndefined();
  });

  it("writes to the configured folder", async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), "open-parcels-backups-"));
    scratch.push(elsewhere);
    const test = await start({ OPENPARCELS_BACKUP_DIR: elsewhere });
    const result = await test.services.backups.run("manual");
    expect(existsSync(path.join(elsewhere, result.file ?? ""))).toBe(true);
    expect(existsSync(path.join(test.dataDir, "backups"))).toBe(false);
  });

  it("reports a failure in the result, the status and a live event", async () => {
    const blocker = path.join(mkdtempSync(path.join(tmpdir(), "open-parcels-blocked-")), "file");
    scratch.push(path.dirname(blocker));
    writeFileSync(blocker, "not a folder");
    const test = await start({ OPENPARCELS_BACKUP_DIR: path.join(blocker, "backups") });
    const result = await test.services.backups.run("scheduled");
    expect(result.ok).toBe(false);
    expect(result.file).toBeNull();
    expect(result.error).toBe("not_a_folder");
    expect(await backupEvents(test)).toEqual([result]);
    const status = await test.services.backups.status();
    expect(status.failing).toBe(true);
    expect(status.last).toEqual(result);
  });

  it("takes a scheduled backup only when the newest one is older than the interval", async () => {
    const test = await start({ OPENPARCELS_BACKUP_HOURS: "24" });
    const backups = test.services.backups;
    expect((await backups.runIfDue())?.reason).toBe("scheduled");
    test.clock.advance(HOUR);
    expect(await backups.runIfDue()).toBeNull();
    expect((await backups.status()).next_at).toBe(
      new Date(test.clock.now().getTime() + 23 * HOUR).toISOString(),
    );
    // Maintenance checks hourly: a backup a few minutes short of the interval is taken now.
    test.clock.advance(23 * HOUR - 2 * 60 * 1000);
    expect((await backups.runIfDue())?.ok).toBe(true);
    expect((await backups.status()).files).toHaveLength(2);
  });

  it("takes no scheduled backups when they are turned off", async () => {
    const test = await start({ OPENPARCELS_BACKUP_HOURS: "0" });
    expect(await test.services.backups.runIfDue()).toBeNull();
    const status = await test.services.backups.status();
    expect(status.next_at).toBeNull();
    expect(status.failing).toBe(false);
    // By hand it still works.
    expect((await test.services.backups.run("manual")).ok).toBe(true);
  });

  it("flags a schedule that has not succeeded for too long", async () => {
    const test = await start({ OPENPARCELS_BACKUP_HOURS: "1" });
    await test.services.backups.run("scheduled");
    test.clock.advance(2 * HOUR);
    expect((await test.services.backups.status()).failing).toBe(false);
    test.clock.advance(2 * HOUR);
    expect((await test.services.backups.status()).failing).toBe(true);
  });
});
