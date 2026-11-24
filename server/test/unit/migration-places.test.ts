import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { migrateToLatest, openDatabase } from "../../src/db/database.js";
import { migrateBefore } from "../helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migration 0014-place-candidates", () => {
  it("forgets the single-point cache, hits and misses, so every name is looked up again", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "open-parcels-migrate-"));
    dirs.push(dir);
    const { db } = openDatabase(path.join(dir, "db.sqlite"));
    try {
      await migrateBefore(db, "0014");
      await sql`
        insert into places (key, latitude, longitude, precision, resolved_at, missed_at)
        values ('hamburg', 53.55, 10.0, 'area', 't', null),
               ('greven', null, null, null, null, 't'),
               ('mayong town', null, null, null, null, 't')
      `.execute(db);

      // Later migrations follow; this test pins only its own.
      expect((await migrateToLatest(db))[0]).toBe("0014-place-candidates");

      expect(await db.selectFrom("places").selectAll().execute()).toEqual([]);
      await db
        .insertInto("places")
        .values({ key: "greven", candidates: "[]", looked_at: "t" })
        .execute();
      expect(await db.selectFrom("places").select("key").execute()).toEqual([{ key: "greven" }]);
    } finally {
      // Windows cannot delete an open database file; close it even when an assertion fails.
      await db.destroy();
    }
  });
});
