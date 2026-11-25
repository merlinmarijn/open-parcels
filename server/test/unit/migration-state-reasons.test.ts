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

const ROWS: readonly (readonly [string, string, string | null])[] = [
  ["a-fresh", "ok", "Not run yet."],
  ["b-rate", "error", "The carrier asked us to slow down."],
  ["c-failed", "error", "The last update failed: Demo answered HTTP 500. Retrying later."],
  ["d-idle", "idle", "Public tracking off: nothing to look up."],
  ["e-config", "error", "Field 'zip' is required."],
  ["f-imported", "needs_sign_in", "The Home Assistant entry holds no DHL refresh token; sign in."],
  ["g-inbox", "error", "The mail server could not be reached; retrying."],
  ["h-fine", "ok", null],
];

describe("migration 0025-state-reasons", () => {
  it("turns stored English texts into reason codes and carrier messages", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "open-parcels-migrate-"));
    dirs.push(dir);
    const { db } = openDatabase(path.join(dir, "db.sqlite"));
    try {
      await migrateBefore(db, "0025");
      for (const [id, state, detail] of ROWS) {
        await sql`
          insert into connections (id, provider, kind, label, state, state_detail, created_at, updated_at)
          values (${id}, 'demo', 'tracking', ${id}, ${state}, ${detail}, 't', 't')
        `.execute(db);
      }
      const backup = { ok: false, reason: "scheduled", error: "ENOSPC: no space left" };
      await sql`
        insert into settings (key, value, updated_at)
        values ('backup_last', ${JSON.stringify(backup)}, 't')
      `.execute(db);

      expect((await migrateToLatest(db))[0]).toBe("0025-state-reasons");

      const rows = await sql<{ id: string }>`
        select id, state_reason, carrier_message from connections order by id
      `.execute(db);
      expect(rows.rows).toEqual([
        { id: "a-fresh", state_reason: "not_run_yet", carrier_message: null },
        { id: "b-rate", state_reason: "rate_limited", carrier_message: null },
        {
          id: "c-failed",
          state_reason: "update_failed",
          carrier_message: "Demo answered HTTP 500.",
        },
        {
          id: "d-idle",
          state_reason: "provider_idle",
          carrier_message: "Public tracking off: nothing to look up.",
        },
        {
          id: "e-config",
          state_reason: "invalid_config",
          carrier_message: "Field 'zip' is required.",
        },
        { id: "f-imported", state_reason: "imported_without_sign_in", carrier_message: null },
        { id: "g-inbox", state_reason: "inbox_unreachable", carrier_message: null },
        { id: "h-fine", state_reason: null, carrier_message: null },
      ]);
      const columns = await sql<{ name: string }>`pragma table_info(connections)`.execute(db);
      expect(columns.rows.map((column) => column.name)).not.toContain("state_detail");
      const stored = await sql<{ value: string }>`
        select value from settings where key = 'backup_last'
      `.execute(db);
      expect(JSON.parse(stored.rows[0]?.value ?? "{}")).toMatchObject({ error: "failed" });
    } finally {
      await db.destroy();
    }
  });
});
