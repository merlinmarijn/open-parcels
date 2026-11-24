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

describe("migration 0019-glossary-names", () => {
  it("renames sources, barcodes, the planned window and directions, keeping every row", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "open-parcels-migrate-"));
    dirs.push(dir);
    const { db } = openDatabase(path.join(dir, "db.sqlite"));
    const raw = db as unknown as Kysely<unknown>;
    try {
      const before = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([name]) => name < "0019"),
      );
      const old = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(before) } });
      expect((await old.migrateToLatest()).error).toBeUndefined();
      await sql`
        insert into sources (id, plugin, kind, label, config, state, created_at, updated_at)
        values ('s-1', 'dhl', 'account', 'DHL account', '{}', 'ok', 't', 't')
      `.execute(raw);
      await sql`
        insert into parcels (id, carrier, barcode, direction, status, delivered, pickup,
                             planned_from, planned_to, first_seen_at, last_seen_at, updated_at)
        values ('p-in', 'dhl', 'X1', 'incoming', 'in_transit', 0, 0, 'a', 'b', 't', 't', 't'),
               ('p-out', 'dhl', 'X2', 'outgoing', 'in_transit', 0, 0, null, null, 't', 't', 't')
      `.execute(raw);
      await sql`
        insert into parcel_sources (parcel_id, source_id, role, last_seen_at)
        values ('p-in', 's-1', 'primary', 't')
      `.execute(raw);
      await sql`
        insert into parcel_events (parcel_id, source_id, at, raw_status, fingerprint)
        values ('p-in', 's-1', 't', 'Scan', 'f-1')
      `.execute(raw);
      await sql`
        insert into outbox (type, payload, created_at) values ('source.added', '{}', 't')
      `.execute(raw);

      expect(await migrateToLatest(db)).toEqual([
        "0019-glossary-names",
        "0020-ha-import-markers",
        "0021-order-totals",
        "0022-live-state-connection",
      ]);

      expect(
        await db
          .selectFrom("parcels")
          .select(["id", "tracking_number", "direction", "expected_from", "expected_to"])
          .orderBy("id")
          .execute(),
      ).toEqual([
        {
          id: "p-in",
          tracking_number: "X1",
          direction: "receiving",
          expected_from: "a",
          expected_to: "b",
        },
        {
          id: "p-out",
          tracking_number: "X2",
          direction: "sending",
          expected_from: null,
          expected_to: null,
        },
      ]);
      expect(await db.selectFrom("connections").select(["id", "provider"]).execute()).toEqual([
        { id: "s-1", provider: "dhl" },
      ]);
      expect(
        await db.selectFrom("parcel_connections").select(["parcel_id", "connection_id"]).execute(),
      ).toEqual([{ parcel_id: "p-in", connection_id: "s-1" }]);
      expect(await db.selectFrom("outbox").selectAll().execute()).toEqual([]);
      // The old values are refused now; the unique key and the foreign keys still hold.
      await expect(
        sql`update parcels set direction = 'incoming' where id = 'p-in'`.execute(raw),
      ).rejects.toThrow(/CHECK/);
      await expect(
        sql`insert into parcels (id, carrier, tracking_number, direction, status, delivered, pickup,
                                 first_seen_at, last_seen_at, updated_at)
            values ('p-twin', 'dhl', 'X1', 'receiving', 'in_transit', 0, 0, 't', 't', 't')`.execute(
          raw,
        ),
      ).rejects.toThrow(/UNIQUE/);
      await db.deleteFrom("parcels").where("id", "=", "p-in").execute();
      expect(await db.selectFrom("parcel_events").selectAll().execute()).toEqual([]);
      expect(await db.selectFrom("parcel_connections").selectAll().execute()).toEqual([]);
    } finally {
      // Windows cannot delete an open database file; close it even when an assertion fails.
      await db.destroy();
    }
  });
});
