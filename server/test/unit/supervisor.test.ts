import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  announceToHomeAssistant,
  APP_INGRESS_PORT,
  isSupervised,
  settingsTokenVault,
  supervisedEnvironment,
} from "../../src/ha/supervisor.js";
import { createTestContext, type TestContext } from "../helpers.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "open-parcels-ha-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Home Assistant app support", () => {
  it("detects the Supervisor by its token", () => {
    expect(isSupervised({})).toBe(false);
    expect(isSupervised({ SUPERVISOR_TOKEN: "x" })).toBe(true);
  });

  it("maps app options to environment variables, letting explicit variables win", () => {
    const file = path.join(dir, "options.json");
    writeFileSync(
      file,
      JSON.stringify({ log_level: "debug", timezone: "Europe/Berlin", archive_days: 14 }),
    );
    const env = supervisedEnvironment({ OPENPARCELS_LOG_LEVEL: "warn" }, file);
    expect(env).toMatchObject({
      OPENPARCELS_LOG_LEVEL: "warn",
      OPENPARCELS_TIMEZONE: "Europe/Berlin",
      OPENPARCELS_ARCHIVE_DAYS: "14",
      OPENPARCELS_INGRESS_PORT: String(APP_INGRESS_PORT),
      OPENPARCELS_DATA_DIR: "/data",
    });
  });

  it("announces itself with the same token on every start, and a new one once revoked (AP-002)", async () => {
    const context: TestContext = await createTestContext();
    try {
      const sent: { url: string; body: unknown }[] = [];
      const fetchImpl = (url: string, init: RequestInit): Promise<Response> => {
        sent.push({ url, body: JSON.parse(typeof init.body === "string" ? init.body : "null") });
        return Promise.resolve(new Response("{}", { status: 200 }));
      };
      const { db, secrets, clock, auth } = context.services;
      const options = {
        token: "supervisor",
        auth,
        // A fresh vault per start, as after a restart: only the database carries the token over.
        get vault() {
          return settingsTokenVault(db, secrets, clock);
        },
        port: 3000,
        logger: pino({ level: "silent" }),
        fetchImpl,
      };
      const announced = (index: number): string =>
        (sent[index]?.body as { config: { api_token: string } }).config.api_token;
      await announceToHomeAssistant(options);
      await announceToHomeAssistant(options);
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatchObject({
        url: "http://supervisor/discovery",
        body: { service: "open_parcels", config: { port: 3000 } },
      });
      expect(announced(1)).toBe(announced(0));
      expect(await auth.findToken(announced(0))).toBeDefined();
      const named = async () =>
        (await auth.listTokens()).filter((token) => token.name.startsWith("Home Assistant"));
      expect(await named()).toHaveLength(1);
      // The value is stored encrypted, never in clear.
      const row = await db
        .selectFrom("settings")
        .select("value")
        .where("key", "=", "ha_discovery_token")
        .executeTakeFirstOrThrow();
      expect(row.value).not.toContain(announced(0));

      // Revoked by the owner: the next start makes and announces a new one.
      const [first] = await named();
      await auth.deleteToken(first?.id ?? "");
      await announceToHomeAssistant(options);
      expect(announced(2)).not.toBe(announced(0));
      expect(await auth.findToken(announced(2))).toBeDefined();
      expect(await named()).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
});
