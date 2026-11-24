/**
 * Writes the OpenAPI document to a file. The web UI generates its typed API client from it.
 *
 * Usage: node dist/tools/export-openapi.js <output.json>
 */
import { writeFileSync } from "node:fs";
import { renderOpenApiDocument } from "../api/openapi-document.js";

async function main(): Promise<void> {
  const output = process.argv[2];
  if (output === undefined) {
    throw new Error("Pass the output file path.");
  }
  writeFileSync(output, await renderOpenApiDocument());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Exporting the OpenAPI document failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
