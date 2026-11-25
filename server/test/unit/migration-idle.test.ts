import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { migrateToLatest, openDatabase } from "../../src/db/database.js";
import type { Database } from "../../src/db/schema.js";
import { migrateBefore } from "../helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function insertSource(
  db: Kysely<Database>,
  id: string,
  state: string,
  detail: string | null,
): Promise<void> {
  await sql`
    insert into sources (id, plugin, kind, label, state, state_detail, created_at, updated_at, auto_created)
    values (${id}, 'dpd', 'tracking', ${id}, ${state}, ${detail}, 't', 't', 1)
  `.execute(db);
}

describe("migration 0009-idle-source-state", () => {
  it("turns OK rows that ran idle into idle, keeps every other row and its links", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "open-parcels-migrate-"));
    dirs.push(dir);
    const { db } = openDatabase(path.join(dir, "db.sqlite"));
    try {
      await migrateBefore(db, "0009");
      await insertSource(db, "idle", "ok", "Public tracking off: nothing to look up.");
      await insertSource(db, "fresh", "ok", "Not run yet.");
      await insertSource(db, "fine", "ok", null);
      await insertSource(db, "broken", "error", "Boom.");
      await sql`
        insert into sign_in_attempts (id, source_id, flow, blob, created_at, expires_at)
        values ('a1', 'fine', 'f', x'00', 't', 't')
      `.execute(db);

      // Later migrations follow; this test pins only its own.
      expect((await migrateToLatest(db))[0]).toBe("0009-idle-source-state");

      // 0025 later turned the texts into reason codes and carrier messages.
      const rows = await sql<{ id: string; state: string; state_reason: string | null }>`
        select id, state, state_reason, carrier_message from connections order by id
      `.execute(db);
      expect(rows.rows).toEqual([
        { id: "broken", state: "error", state_reason: "invalid_config", carrier_message: "Boom." },
        { id: "fine", state: "ok", state_reason: null, carrier_message: null },
        { id: "fresh", state: "ok", state_reason: "not_run_yet", carrier_message: null },
        {
          id: "idle",
          state: "idle",
          state_reason: "provider_idle",
          carrier_message: "Public tracking off: nothing to look up.",
        },
      ]);
      // The rebuild did not cascade into rows that point at a connection.
      const attempts = await sql`select id from sign_in_attempts`.execute(db);
      expect(attempts.rows).toHaveLength(1);
      // Foreign keys are back on and still enforced.
      const fk = await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(db);
      expect(fk.rows[0]?.foreign_keys).toBe(1);
      await sql`delete from connections where id = 'fine'`.execute(db);
      expect((await sql`select id from sign_in_attempts`.execute(db)).rows).toHaveLength(0);
      // The constraint still rejects unknown states.
      await expect(
        sql`update connections set state = 'sleepy' where id = 'idle'`.execute(db),
      ).rejects.toThrow(/CHECK/);
    } finally {
      await db.destroy();
    }
  });
});
