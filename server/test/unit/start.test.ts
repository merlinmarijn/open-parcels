import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { secretAad } from "../../src/engine/connections.js";
import { loadSecretKey, SecretBox } from "../../src/crypto/secrets.js";
import { migrateToLatest, openDatabase } from "../../src/db/database.js";
import { startServer, type RunningServer } from "../../src/server.js";

const NOW = new Date().toISOString();
const mailSecret = { username: "someone@example.invalid", password: ["made", "up"].join("-") };

let dataDir: string | undefined;
let server: RunningServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) =>
    probe.close(() => {
      resolve();
    }),
  );
  if (address === null || typeof address === "string") throw new Error("No port.");
  return address.port;
}

/** A database holding one broken connection of each kind the server starts something for. */
async function brokenDatabase(dir: string): Promise<void> {
  const { key } = loadSecretKey(undefined, dir);
  const { db } = openDatabase(path.join(dir, "openparcels.db"));
  await migrateToLatest(db);
  const row = (id: string, provider: string, kind: "mail" | "account", config: string) => ({
    id,
    provider,
    kind,
    label: id,
    config,
    secret_blob: null,
    session_blob: null,
    state: "ok" as const,
    state_detail: null,
    next_run_at: kind === "mail" ? null : NOW,
    created_at: NOW,
    updated_at: NOW,
  });
  // Encrypted with a key the server does not have (the key file was replaced).
  const lostKey = new SecretBox(randomBytes(32)).encryptJson(mailSecret, secretAad("lost-key"));
  await db
    .insertInto("connections")
    .values([
      {
        ...row("lost-key", "imap", "mail", '{"host":"imap.example.invalid"}'),
        secret_blob: lostKey,
      },
      {
        ...row("bad-config", "imap", "mail", "{}"),
        secret_blob: new SecretBox(key).encryptJson(mailSecret, secretAad("bad-config")),
      },
      {
        ...row("demo-lost-key", "demo", "account", "{}"),
        secret_blob: new SecretBox(randomBytes(32)).encryptJson({}, secretAad("demo-lost-key")),
      },
      row("uninstalled", "gone", "account", "{}"),
    ])
    .execute();
  await db.destroy();
}

describe("start-up and shutdown (OP-070)", () => {
  it("come up over a database with a broken connection of each kind, serve, and stop cleanly", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "open-parcels-start-"));
    await brokenDatabase(dataDir);
    const port = await freePort();
    server = await startServer({
      OPENPARCELS_DATA_DIR: dataDir,
      OPENPARCELS_HOST: "127.0.0.1",
      OPENPARCELS_PORT: String(port),
      OPENPARCELS_WEB_DIR: dataDir,
      OPENPARCELS_LOG_LEVEL: "fatal",
      OPENPARCELS_TIMEZONE: "Europe/Berlin",
    });

    const ready = await fetch(`http://127.0.0.1:${String(port)}/api/v1/health/ready`);
    expect(ready.status).toBe(200);
    const { connections } = server.services;
    expect(await connections.get("lost-key")).toMatchObject({ state: "needs_sign_in" });
    expect(await connections.get("bad-config")).toMatchObject({ state: "error" });
    // The scheduler ran the broken provider connections at start without taking the server down.
    await expect.poll(async () => (await connections.get("uninstalled"))?.state).toBe("error");
    await expect
      .poll(async () => (await connections.get("demo-lost-key"))?.state)
      .toBe("needs_sign_in");
    expect((await fetch(`http://127.0.0.1:${String(port)}/api/v1/health/live`)).status).toBe(200);

    const running = server;
    server = undefined;
    await running.stop();
    await expect(fetch(`http://127.0.0.1:${String(port)}/api/v1/health/live`)).rejects.toThrow();
  });
});
