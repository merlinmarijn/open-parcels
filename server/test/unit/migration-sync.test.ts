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

describe("migration 0027-sync-changes", () => {
  it("lists every existing row once and keeps the list from then on", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "open-parcels-migrate-"));
    dirs.push(dir);
    const { db } = openDatabase(path.join(dir, "db.sqlite"));
    try {
      await migrateBefore(db, "0027");
      await sql`
        insert into connections (id, provider, kind, label, state, created_at, updated_at)
        values ('c1', 'demo', 'tracking', 'Demo', 'ok', 't', 't')
      `.execute(db);
      await sql`
        insert into parcels (id, carrier, tracking_number, direction, status, delivered, pickup,
          first_seen_at, last_seen_at, updated_at)
        values ('p1', 'demo', 'DEMO1', 'receiving', 'in_transit', 0, 0, 't', 't', 't')
      `.execute(db);
      await sql`
        insert into parcel_events (parcel_id, at, raw_status, fingerprint)
        values ('p1', '2026-11-17T08:00:00.000Z', 'Made-up scan', 'f1')
      `.execute(db);

      await migrateToLatest(db);
      const listed = await sql<{ entity: string; entity_id: string; deleted: number }>`
        select entity, entity_id, deleted from sync_changes order by seq
      `.execute(db);
      expect(listed.rows).toEqual([
        { entity: "connection", entity_id: "c1", deleted: 0 },
        { entity: "parcel", entity_id: "p1", deleted: 0 },
        { entity: "event", entity_id: "1", deleted: 0 },
      ]);
      const event = await sql<{ updated_at: string }>`select updated_at from parcel_events`.execute(
        db,
      );
      expect(event.rows[0]?.updated_at).toBe("2026-11-17T08:00:00.000Z");

      // Seen again by a run: not a change. A new status: a change. Deleting: tombstones.
      await sql`update parcels set last_seen_at = 'u' where id = 'p1'`.execute(db);
      expect((await sql`select * from sync_changes`.execute(db)).rows).toHaveLength(3);
      await sql`update parcels set status = 'delivered' where id = 'p1'`.execute(db);
      await sql`delete from parcels where id = 'p1'`.execute(db);
      const after = await sql<{ entity: string; deleted: number }>`
        select entity, deleted from sync_changes order by seq
      `.execute(db);
      expect(after.rows).toHaveLength(3);
      expect(after.rows).toEqual(
        expect.arrayContaining([
          { entity: "connection", deleted: 0 },
          { entity: "parcel", deleted: 1 },
          { entity: "event", deleted: 1 },
        ]),
      );
    } finally {
      await db.destroy();
    }
  });
});
