import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.js";

class DryRunRollback extends Error {
  override readonly name = "DryRunRollback";
}

/**
 * Runs an import in one transaction. A dry run does all of it and then rolls back, so it
 * validates everything and changes nothing.
 */
export async function inImportTransaction(
  db: Kysely<Database>,
  dryRun: boolean,
  work: (trx: Transaction<Database>) => Promise<void>,
): Promise<void> {
  try {
    await db.transaction().execute(async (trx) => {
      await work(trx);
      if (dryRun) {
        throw new DryRunRollback("Dry run: rolling back.");
      }
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) {
      throw error;
    }
  }
}

/** A trimmed, non-empty string from imported data, or null. */
export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
