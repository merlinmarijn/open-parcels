import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSecretKey } from "../../src/crypto/secrets.js";
import { openDatabase } from "../../src/db/database.js";
import { parseImportArgs, withImportTarget } from "../../src/tools/import-target.js";

const USAGE = "Usage: tool <input> [--dry-run]";

describe("import tool arguments (OP-127)", () => {
  it("take one input and --dry-run, and refuse anything else", () => {
    expect(parseImportArgs(["old.db"], USAGE)).toEqual({ input: "old.db", dryRun: false });
    expect(parseImportArgs(["--dry-run", "-"], USAGE)).toEqual({ input: "-", dryRun: true });
    expect(() => parseImportArgs(["old.db", "--dryrun"], USAGE)).toThrow();
    expect(() => parseImportArgs(["old.db", "-n"], USAGE)).toThrow();
    expect(() => parseImportArgs(["a.db", "b.db"], USAGE)).toThrow(USAGE);
    expect(() => parseImportArgs([], USAGE)).toThrow(USAGE);
  });
});

describe("a dry run (OP-127)", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "open-parcels-tool-"));
    vi.stubEnv("OPENPARCELS_DATA_DIR", dataDir);
    vi.stubEnv("OPENPARCELS_SECRET_KEY", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("on a fresh installation runs with a throwaway key and creates nothing", async () => {
    await expect(withImportTarget(true, () => Promise.resolve(1))).resolves.toBe(1);
    expect(existsSync(path.join(dataDir, "secret.key"))).toBe(false);
    expect(existsSync(path.join(dataDir, "openparcels.db"))).toBe(false);
  });

  it("refuses a database without its encryption key", async () => {
    openDatabase(path.join(dataDir, "openparcels.db")).sqlite.close();
    await expect(withImportTarget(true, () => Promise.resolve(0))).rejects.toThrow(
      /no encryption key/,
    );
    expect(existsSync(path.join(dataDir, "secret.key"))).toBe(false);
  });

  it("neither migrates nor writes the real database", async () => {
    loadSecretKey(undefined, dataDir);
    const file = path.join(dataDir, "openparcels.db");
    const { sqlite } = openDatabase(file);
    sqlite.exec("create table marker (id integer)");
    sqlite.close();
    const before = readFileSync(file);

    const tables = await withImportTarget(true, async (db) => {
      await db.insertInto("settings").values({ key: "x", value: "1", updated_at: "now" }).execute();
      return (await db.introspection.getTables()).map((table) => table.name);
    });
    // The copy was migrated and written to; the real file is byte for byte as it was.
    expect(tables).toContain("parcels");
    expect(tables).toContain("marker");
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});
