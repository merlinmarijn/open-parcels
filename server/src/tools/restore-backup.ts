/**
 * Restores a database backup into this installation. Stop open-parcels first.
 *
 * Usage: node dist/tools/restore-backup.js <backup file> [--dry-run] [--force]
 *
 * Uses the same OPENPARCELS_* environment as the server (data directory, encryption key). Checks
 * the backup (integrity, written by this or an older version), keeps the database it replaces next
 * to it, and prints counts only. `--dry-run` checks without changing anything; `--force` restores
 * although the database looks open (only after a server that did not shut down cleanly).
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { systemClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { loadSecretKey, SecretBox, SecretKeyError } from "../crypto/secrets.js";
import { restoreBackup } from "../data/restore.js";
import { runTool, type ToolMain, type ToolOutput } from "./cli.js";

const USAGE = "Usage: restore-backup <backup file> [--dry-run] [--force]";

function installationSecrets(
  secretKey: string | undefined,
  dataDir: string,
): SecretBox | undefined {
  try {
    return new SecretBox(loadSecretKey(secretKey, dataDir, { create: false }).key);
  } catch (error) {
    if (error instanceof SecretKeyError) return undefined;
    throw error;
  }
}

function restore(argv: readonly string[], output: ToolOutput): void {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { "dry-run": { type: "boolean" }, force: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  const [backup] = positionals;
  if (backup === undefined || positionals.length !== 1) {
    throw new Error(USAGE);
  }
  const config = loadConfig();
  // A bare file name means one in the backup folder.
  const file = backup.includes(path.sep) ? backup : path.join(config.backup.directory, backup);
  const report = restoreBackup({
    backup: file,
    databasePath: config.databasePath,
    now: systemClock.now(),
    dryRun: values["dry-run"] === true,
    force: values.force === true,
    secrets: installationSecrets(config.secretKey, config.dataDir),
  });
  output.out(`${JSON.stringify(report, null, 2)}\n`);
  if (report.keyMatches === false) {
    output.err(
      "This installation's encryption key does not open the backup's sign-ins: restore the secret.key (or OPENPARCELS_SECRET_KEY) the backup was made with, or sign every connection in again.\n",
    );
  }
  if (!report.dryRun) {
    output.err("Restored. Start open-parcels again; it applies any newer database migrations.\n");
  }
}

// The restore itself is synchronous; a throw becomes the rejection `runTool` reports.
export const main: ToolMain = (argv, output) =>
  new Promise((resolve) => {
    restore(argv, output);
    resolve();
  });

if (import.meta.main) {
  runTool("Restore failed", main);
}
