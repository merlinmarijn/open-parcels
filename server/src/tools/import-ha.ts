/**
 * Imports the Home Assistant parcel suite's config entries as signed-in connections.
 *
 * Usage: node dist/tools/import-ha.js <path to .storage/core.config_entries | -> [--dry-run]
 *
 * `-` reads the file from stdin. Uses the same OPENPARCELS_* environment as the server (data
 * directory, encryption key). Prints labels, states and counts; never a token. A dry run works on
 * a temporary copy of the database and changes nothing.
 */
import { readFileSync } from "node:fs";
import { systemClock } from "../clock.js";
import { importHaEntries } from "../migrate/ha/import.js";
import { parseImportArgs, RESTART_NOTICE, withImportTarget } from "./import-target.js";
import { runTool, type ToolMain } from "./cli.js";

class InputError extends Error {
  override readonly name = "InputError";
}

/** Reads the entries file. Its parse error may quote the input, which holds tokens: never shown. */
function readEntries(input: string): unknown {
  const text = readFileSync(input === "-" ? 0 : input, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InputError("The input is not valid JSON.");
  }
}

export const main: ToolMain = async (argv, output) => {
  const { input, dryRun } = parseImportArgs(
    argv,
    "Usage: import-ha <path of core.config_entries, or - for stdin> [--dry-run]",
  );
  const configEntries = readEntries(input);
  const report = await withImportTarget(dryRun, (db, secrets) =>
    importHaEntries({ configEntries, db, secrets, clock: systemClock, dryRun }),
  );
  output.out(`${JSON.stringify(report, null, 2)}\n`);
  if (!dryRun) {
    output.err(RESTART_NOTICE);
  }
};

if (import.meta.main) {
  runTool("Import failed", main);
}
