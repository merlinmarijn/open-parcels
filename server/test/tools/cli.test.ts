import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import SQLite from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { loadSecretKey } from "../../src/crypto/secrets.js";
import { migrateToLatest, openDatabase } from "../../src/db/database.js";
import { main as exportOpenApi } from "../../src/tools/export-openapi.js";
import { main as importHa } from "../../src/tools/import-ha.js";
import { main as importLegacy } from "../../src/tools/import-legacy.js";

/** Made-up sign-in value, built from parts. */
const TOKEN = ["fake", "refresh", "0000"].join("-");

let dir: string;
let database: string;
let output: { out: Mock<(text: string) => void>; err: Mock<(text: string) => void> };
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "open-parcels-cli-"));
  database = path.join(dir, "openparcels.db");
  output = { out: vi.fn(), err: vi.fn() };
  vi.stubEnv("OPENPARCELS_DATA_DIR", dir);
  vi.stubEnv("OPENPARCELS_SECRET_KEY", undefined);
  vi.stubEnv("OPENPARCELS_LEGACY_KEY", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const printed = (fn: Mock<(text: string) => void>): string => fn.mock.calls.flat().join("");

async function existingInstall(): Promise<Buffer> {
  loadSecretKey(undefined, dir);
  const { db } = openDatabase(database);
  await migrateToLatest(db);
  await db.destroy();
  return readFileSync(database);
}

function entriesFile(content: string): string {
  const file = path.join(dir, "core.config_entries");
  writeFileSync(file, content);
  return file;
}

const DHL_ENTRY = JSON.stringify({
  data: {
    entries: [
      {
        entry_id: "e-dhl",
        domain: "dhl",
        title: "Germany (Test)",
        data: { account_subject: "sub-1", country: "DE", refresh_token: TOKEN },
        options: {},
        disabled_by: null,
        source: "user",
      },
    ],
  },
});

describe("import-ha (OP-142)", () => {
  it("refuses an unknown option and a missing input with its usage", async () => {
    await expect(importHa([], output)).rejects.toThrow(/^Usage: import-ha/);
    await expect(importHa(["x", "--force"], output)).rejects.toThrow();
  });

  it("never quotes the input in its parse error: it holds tokens", async () => {
    const file = entriesFile(`{"refresh_token": "${TOKEN}",`);
    const failure = importHa([file, "--dry-run"], output);
    await expect(failure).rejects.toThrow("The input is not valid JSON.");
    await expect(failure).rejects.not.toThrow(TOKEN);
  });

  it("reports a dry run without a token, leaving the database as it was", async () => {
    const before = await existingInstall();
    await importHa([entriesFile(DHL_ENTRY), "--dry-run"], output);
    const report = printed(output.out);
    expect(JSON.parse(report)).toMatchObject({ dryRun: true });
    expect(report).not.toContain(TOKEN);
    expect(output.err).not.toHaveBeenCalled();
    expect(readFileSync(database).equals(before)).toBe(true);
  });

  it("imports for real and asks for a restart", async () => {
    await existingInstall();
    await importHa([entriesFile(DHL_ENTRY)], output);
    expect(printed(output.out)).not.toContain(TOKEN);
    expect(printed(output.err)).toMatch(/^Imported\. Restart open-parcels/);
    const sqlite = new SQLite(database, { readonly: true });
    try {
      expect(sqlite.prepare("select count(*) as n from connections").get()).toEqual({ n: 1 });
    } finally {
      sqlite.close();
    }
  });
});

describe("import-legacy (OP-142)", () => {
  it("names a missing old database", async () => {
    await existingInstall();
    await expect(importLegacy([path.join(dir, "missing.db")], output)).rejects.toThrow();
    expect(output.out).not.toHaveBeenCalled();
  });

  it("refuses a malformed old key without quoting it", async () => {
    await existingInstall();
    const old = path.join(dir, "old.db");
    new SQLite(old).close();
    const key = "ab".repeat(20);
    vi.stubEnv("OPENPARCELS_LEGACY_KEY", key);
    const failure = importLegacy([old, "--dry-run"], output);
    await expect(failure).rejects.toThrow("The old encryption key must be 64 hex characters.");
    await expect(failure).rejects.not.toThrow(key);
  });

  it("creates no key and no database on a dry run of a fresh install", async () => {
    const old = path.join(dir, "old.db");
    new SQLite(old).close();
    await expect(importLegacy([old, "--dry-run"], output)).rejects.toThrow(/no encryption key/);
    expect(existsSync(path.join(dir, "secret.key"))).toBe(false);
    expect(existsSync(database)).toBe(false);
  });
});

describe("export-openapi (OP-142)", () => {
  it("writes the document and needs a path", async () => {
    await expect(exportOpenApi([], output)).rejects.toThrow("Pass the output file path.");
    const file = path.join(dir, "openapi.json");
    await exportOpenApi([file], output);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveProperty("openapi");
  });
});
