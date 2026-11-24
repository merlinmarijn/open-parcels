import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Migrator } from "kysely/migration";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrateToLatest, openDatabase } from "../../src/db/database.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migration 0020-ha-import-markers", () => {
  it("renames sourceId to connectionId in Home Assistant import markers, once", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "open-parcels-migrate-"));
    dirs.push(dir);
    const { db } = openDatabase(path.join(dir, "db.sqlite"));
    try {
      const before = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([name]) => name < "0020"),
      );
      const old = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(before) } });
      expect((await old.migrateToLatest()).error).toBeUndefined();
      await db
        .insertInto("settings")
        .values([
          {
            key: "ha_import:old",
            value: JSON.stringify({ sourceId: "c-1", credentials: "f", adopted: true }),
            updated_at: "t",
          },
          {
            key: "ha_import:new",
            value: JSON.stringify({ connectionId: "c-2", credentials: "g" }),
            updated_at: "t",
          },
          { key: "ha_import:broken", value: "not json", updated_at: "t" },
          { key: "other", value: JSON.stringify({ sourceId: "x" }), updated_at: "t" },
        ])
        .execute();

      expect(await migrateToLatest(db)).toEqual(["0020-ha-import-markers", "0021-order-totals"]);

      const rows = await db
        .selectFrom("settings")
        .select(["key", "value"])
        .orderBy("key")
        .execute();
      expect(Object.fromEntries(rows.map((row) => [row.key, row.value]))).toEqual({
        "ha_import:broken": "not json",
        "ha_import:new": JSON.stringify({ connectionId: "c-2", credentials: "g" }),
        "ha_import:old": JSON.stringify({ credentials: "f", adopted: true, connectionId: "c-1" }),
        other: JSON.stringify({ sourceId: "x" }),
      });
    } finally {
      await db.destroy();
    }
  });
});
