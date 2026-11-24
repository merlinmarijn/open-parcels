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

describe("migration 0018-returns", () => {
  it("adds returns linked to orders, sources, items and parcels, and the return window", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "open-parcels-migrate-"));
    dirs.push(dir);
    const { db } = openDatabase(path.join(dir, "db.sqlite"));
    const raw = db as unknown as Kysely<unknown>;
    try {
      const before = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([name]) => name < "0018"),
      );
      const old = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(before) } });
      expect((await old.migrateToLatest()).error).toBeUndefined();
      await sql`
        insert into orders (id, shop, order_number, created_at, updated_at)
        values ('o-1', 'example-shop.de', 'A-1', 't', 't')
      `.execute(raw);
      await sql`
        insert into sources (id, plugin, kind, label, config, state, created_at, updated_at)
        values ('s-1', 'demo_shop', 'shop', 'Demo shop', '{}', 'ok', 't', 't')
      `.execute(raw);

      expect(await migrateToLatest(db)).toEqual(["0018-returns"]);

      const order = await db.selectFrom("orders").select("return_until").executeTakeFirst();
      expect(order).toEqual({ return_until: null });
      await db
        .insertInto("returns")
        .values({
          id: "r-1",
          order_id: "o-1",
          external_ref: null,
          status: "requested",
          reason: null,
          return_by: "2026-12-01",
          drop_off: "[]",
          cost_free: 1,
          cost_amount: null,
          cost_currency: null,
          label_url: null,
          carrier: null,
          tracking_number: null,
          parcel_id: null,
          refund_amount: null,
          refund_currency: null,
          refund_status: null,
          created_at: "t",
          updated_at: "t",
        })
        .execute();
      await db
        .insertInto("return_sources")
        .values({ return_id: "r-1", source_id: "s-1" })
        .execute();
      await db
        .insertInto("return_items")
        .values({ return_id: "r-1", position: 0, title: "Example", order_item_id: null })
        .execute();
      // Deleting the order takes its returns, their links and items with it.
      await db.deleteFrom("orders").where("id", "=", "o-1").execute();
      expect(await db.selectFrom("returns").selectAll().execute()).toEqual([]);
      expect(await db.selectFrom("return_sources").selectAll().execute()).toEqual([]);
      expect(await db.selectFrom("return_items").selectAll().execute()).toEqual([]);
    } finally {
      // Windows cannot delete an open database file; close it even when an assertion fails.
      await db.destroy();
    }
  });
});
