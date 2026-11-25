import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pino } from "pino";
import { systemClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { SecretBox } from "../crypto/secrets.js";
import { migrateToLatest, openDatabase } from "../db/database.js";
import { createServices } from "../services.js";
import { buildApp } from "./app.js";

/**
 * The OpenAPI document as `docs/openapi.json` holds it, without starting a server or touching real
 * data: the server is built against a throwaway database in a temporary directory.
 */
export async function renderOpenApiDocument(): Promise<string> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "open-parcels-openapi-"));
  try {
    const config = loadConfig({ OPENPARCELS_DATA_DIR: dataDir, OPENPARCELS_TIMEZONE: "UTC" });
    const { db } = openDatabase(config.databasePath);
    await migrateToLatest(db);
    const services = await createServices({
      config,
      db,
      logger: pino({ level: "silent" }),
      clock: systemClock,
      secrets: new SecretBox(randomBytes(32)),
    });
    const app = await buildApp(services);
    const document = `${JSON.stringify(app.swagger(), null, 2)}\n`;
    await app.close();
    await db.destroy();
    return document;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}
