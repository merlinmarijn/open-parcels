import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrateToLatest, openDatabase } from "../../src/db/database.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migration 0015-order-sources", () => {
  it("links orders through their parcels, else to the shop source of the same name", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "open-parcels-migrate-"));
    dirs.push(dir);
    const { db } = openDatabase(path.join(dir, "db.sqlite"));
    const raw = db as unknown as Kysely<unknown>;
    try {
      const before = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([name]) => name < "0015"),
      );
      const old = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(before) } });
      expect((await old.migrateToLatest()).error).toBeUndefined();
      await sql`
        insert into sources (id, plugin, kind, label, config, state, created_at, updated_at)
        values ('s-shop', 'demo_shop', 'shop', 'Demo shop', '{}', 'disabled', 't', 't'),
               ('s-track', 'dhl', 'tracking', 'DHL tracking', '{}', 'ok', 't', 't')
      `.execute(raw);
      await sql`
        insert into orders (id, shop, order_number, created_at, updated_at)
        values ('o-parcel', 'elsewhere', 'A-1', 't', 't'),
               ('o-named', 'Demo shop', 'A-2', 't', 't'),
               ('o-none', 'unknown shop', 'A-3', 't', 't')
      `.execute(raw);
      await sql`
        insert into parcels (id, carrier, barcode, direction, status, delivered, pickup,
                             order_id, first_seen_at, last_seen_at, updated_at)
        values ('p-1', 'dhl', 'X1', 'incoming', 'in_transit', 0, 0, 'o-parcel', 't', 't', 't')
      `.execute(raw);
      await sql`
        insert into parcel_sources (parcel_id, source_id, role, last_seen_at)
        values ('p-1', 's-track', 'primary', 't')
      `.execute(raw);

      expect(await migrateToLatest(db)).toEqual([
        "0015-order-sources",
        "0016-manual-at",
        "0017-join-indexes",
        "0018-returns",
      ]);

      const links = await db
        .selectFrom("order_sources")
        .select(["order_id", "source_id"])
        .orderBy("order_id")
        .execute();
      expect(links).toEqual([
        { order_id: "o-named", source_id: "s-shop" },
        { order_id: "o-parcel", source_id: "s-track" },
      ]);
    } finally {
      // Windows cannot delete an open database file; close it even when an assertion fails.
      await db.destroy();
    }
  });
});
