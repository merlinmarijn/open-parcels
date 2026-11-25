/**
 * Imports the database of the pre-rewrite open-parcels into this installation.
 *
 * Usage: node dist/tools/import-legacy.js <path to old data.db> [--dry-run]
 *
 * Uses the same OPENPARCELS_* environment as the server (data directory, encryption key). The old
 * encryption key, needed only to carry IMAP inboxes over, is read from OPENPARCELS_LEGACY_KEY,
 * never from the command line. Prints counts only; no parcel data is written to the output.
 * A dry run works on a temporary copy of the database and changes nothing.
 */
import { systemClock } from "../clock.js";
import { importLegacy } from "../migrate/legacy.js";
import { parseImportArgs, RESTART_NOTICE, withImportTarget } from "./import-target.js";
import { runTool, type ToolMain } from "./cli.js";

export const main: ToolMain = async (argv, output) => {
  const { input, dryRun } = parseImportArgs(
    argv,
    "Usage: import-legacy <path of the old data.db> [--dry-run]",
  );
  const report = await withImportTarget(dryRun, (db, secrets) =>
    importLegacy({
      legacyPath: input,
      db,
      secrets,
      clock: systemClock,
      legacyKeyHex: process.env["OPENPARCELS_LEGACY_KEY"],
      dryRun,
    }),
  );
  output.out(`${JSON.stringify(report, null, 2)}\n`);
  if (!dryRun) {
    output.err(RESTART_NOTICE);
  }
};

if (import.meta.main) {
  runTool("Import failed", main);
}
