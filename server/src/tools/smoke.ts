/**
 * Starts a built server once against an empty data folder and waits until it answers ready: the
 * image build runs it on the bundled layout, so a bundling mistake (a missing native module, a
 * file read from the wrong place) fails the build instead of the first start of a user.
 *
 * Usage: node smoke.js <server main.js>
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 3999;
const DEADLINE_MS = 30_000;
const POLL_MS = 500;

async function ready(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${String(PORT)}/api/v1/health/ready`)).ok;
  } catch {
    // Not listening yet.
    return false;
  }
}

async function main(): Promise<number> {
  const entry = process.argv[2];
  if (entry === undefined) {
    process.stderr.write("Usage: node smoke.js <server main.js>\n");
    return 2;
  }
  const dataDir = mkdtempSync(path.join(tmpdir(), "open-parcels-smoke-"));
  const server = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      OPENPARCELS_DATA_DIR: dataDir,
      OPENPARCELS_HOST: "127.0.0.1",
      OPENPARCELS_PORT: String(PORT),
    },
    stdio: "inherit",
  });
  // An object, so the loop re-reads what the exit handler wrote.
  const child = { exited: false };
  server.once("exit", () => {
    child.exited = true;
  });
  try {
    for (const started = Date.now(); Date.now() - started < DEADLINE_MS && !child.exited;) {
      if (await ready()) {
        process.stdout.write("Smoke test: the server answered ready.\n");
        return 0;
      }
      await sleep(POLL_MS);
    }
    process.stderr.write("Smoke test: the server never answered ready.\n");
    return 1;
  } finally {
    server.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
  }
}

process.exitCode = await main();
