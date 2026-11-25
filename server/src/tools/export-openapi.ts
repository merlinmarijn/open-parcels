/**
 * Writes the OpenAPI document to a file. The web UI generates its typed API client from it.
 *
 * Usage: node dist/tools/export-openapi.js <output.json>
 */
import { writeFileSync } from "node:fs";
import { renderOpenApiDocument } from "../api/openapi-document.js";
import { runTool, type ToolMain } from "./cli.js";

export const main: ToolMain = async ([file]) => {
  if (file === undefined) {
    throw new Error("Pass the output file path.");
  }
  writeFileSync(file, await renderOpenApiDocument());
};

if (import.meta.main) {
  runTool("Exporting the OpenAPI document failed", main);
}
