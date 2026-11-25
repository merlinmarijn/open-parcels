import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateToLatest, openDatabase } from "../../src/db/database.js";
import { SETTINGS } from "../../src/config.js";
import { migrateBefore } from "../helpers.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Migrates to just before 0023, lets `prepare` fill the database, then runs 0023 onwards. */
async function saved(
  prepare: (db: ReturnType<typeof openDatabase>["db"]) => Promise<void>,
): Promise<string | null> {
  const dir = mkdtempSync(path.join(tmpdir(), "open-parcels-migrate-"));
  dirs.push(dir);
  const { db } = openDatabase(path.join(dir, "db.sqlite"));
  try {
    await migrateBefore(db, "0023");
    await prepare(db);
    expect((await migrateToLatest(db))[0]).toBe("0023-geocoding-opt-in");
    const row = await db
      .selectFrom("setting_overrides")
      .select("value")
      .where("key", "=", "OPENPARCELS_GEOCODING")
      .executeTakeFirst();
    return row?.value ?? null;
  } finally {
    await db.destroy();
  }
}

const usedInstall = async (db: ReturnType<typeof openDatabase>["db"]): Promise<void> => {
  await db.insertInto("settings").values({ key: "home", value: "{}", updated_at: "t" }).execute();
};

describe("migration 0023-geocoding-opt-in (OP-079)", () => {
  it("is off by default for new installs", () => {
    expect(SETTINGS.OPENPARCELS_GEOCODING.default).toBe(false);
  });

  it("keeps the background place lookup on for an install that ran with the old default", async () => {
    vi.stubEnv("OPENPARCELS_GEOCODING", undefined);
    expect(await saved(usedInstall)).toBe("true");
  });

  it("saves nothing for a new, empty database", async () => {
    vi.stubEnv("OPENPARCELS_GEOCODING", undefined);
    expect(await saved(() => Promise.resolve())).toBeNull();
  });

  it("leaves a value saved in the UI alone", async () => {
    vi.stubEnv("OPENPARCELS_GEOCODING", undefined);
    const value = await saved(async (db) => {
      await usedInstall(db);
      await db
        .insertInto("setting_overrides")
        .values({ key: "OPENPARCELS_GEOCODING", value: "false", updated_at: "t" })
        .execute();
    });
    expect(value).toBe("false");
  });

  it("saves nothing while the environment sets the variable, which keeps applying", async () => {
    vi.stubEnv("OPENPARCELS_GEOCODING", "false");
    expect(await saved(usedInstall)).toBeNull();
  });
});
