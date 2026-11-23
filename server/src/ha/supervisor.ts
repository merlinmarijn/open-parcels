import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Logger } from "pino";
import type { AuthStore } from "../auth/store.js";
import { isoNow, type Clock } from "../clock.js";
import { DecryptionError, type SecretBox } from "../crypto/secrets.js";
import type { Database } from "../db/schema.js";

/** Ingress port the Home Assistant app declares; the Supervisor proxies the web UI to it. */
export const APP_INGRESS_PORT = 8099;
const SUPERVISOR_URL = "http://supervisor";
/** Integration domain the app announces itself to. */
export const DISCOVERY_SERVICE = "open_parcels";
const DISCOVERY_TOKEN_NAME = "Home Assistant (discovery)";

/** Options shown in the app's configuration tab; each maps to an OPENPARCELS_* variable. */
const optionsSchema = z
  .object({
    log_level: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),
    timezone: z.string().optional(),
    public_url: z.string().optional(),
    archive_days: z.number().int().optional(),
    delete_days: z.number().int().optional(),
    quiet_window: z.boolean().optional(),
  })
  .loose();

/** True when running as a Home Assistant app: the Supervisor injects its token. */
export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  const token = env["SUPERVISOR_TOKEN"];
  return token !== undefined && token !== "";
}

/**
 * Environment additions for a supervised start: the app's options become OPENPARCELS_* variables
 * (explicit environment variables still win) and the ingress listener is switched on.
 */
export function supervisedEnvironment(
  env: NodeJS.ProcessEnv,
  optionsFile = "/data/options.json",
): NodeJS.ProcessEnv {
  const options = existsSync(optionsFile)
    ? optionsSchema.parse(JSON.parse(readFileSync(optionsFile, "utf8")))
    : {};
  const mapped: Record<string, string | undefined> = {
    OPENPARCELS_LOG_LEVEL: options.log_level,
    OPENPARCELS_TIMEZONE: options.timezone,
    OPENPARCELS_PUBLIC_URL: options.public_url,
    OPENPARCELS_ARCHIVE_DAYS: options.archive_days?.toString(),
    OPENPARCELS_DELETE_DAYS: options.delete_days?.toString(),
    OPENPARCELS_QUIET_WINDOW: options.quiet_window?.toString(),
    OPENPARCELS_INGRESS_PORT: String(APP_INGRESS_PORT),
    OPENPARCELS_DATA_DIR: "/data",
  };
  const result: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(mapped)) {
    if (value !== undefined && value !== "" && result[key] === undefined) {
      result[key] = value;
    }
  }
  return result;
}

/** Where the discovery token is kept between starts, so it can be announced again unchanged. */
export interface TokenVault {
  /** The stored token, or null when there is none or it cannot be read. */
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
}

const VAULT_KEY = "ha_discovery_token";
const vaultAad = "settings:ha_discovery_token";

/** Keeps the token encrypted in the settings table, bound to its row like source secrets. */
export function settingsTokenVault(
  db: Kysely<Database>,
  secrets: SecretBox,
  clock: Clock,
): TokenVault {
  return {
    async load() {
      const row = await db
        .selectFrom("settings")
        .select("value")
        .where("key", "=", VAULT_KEY)
        .executeTakeFirst();
      if (row === undefined) {
        return null;
      }
      try {
        return secrets.decrypt(Buffer.from(row.value, "base64"), vaultAad);
      } catch (error) {
        if (error instanceof DecryptionError) {
          // A changed encryption key: a new token is made and announced.
          return null;
        }
        throw error;
      }
    },
    async save(token) {
      const value = secrets.encrypt(token, vaultAad).toString("base64");
      const now = isoNow(clock);
      await db
        .insertInto("settings")
        .values({ key: VAULT_KEY, value, updated_at: now })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now }))
        .execute();
    },
  };
}

export interface DiscoveryOptions {
  readonly token: string;
  readonly auth: AuthStore;
  readonly vault: TokenVault;
  readonly port: number;
  readonly logger: Logger;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * The API token the integration uses: the one made on an earlier start while it is still valid,
 * so the integration's stored copy keeps working across restarts. Only when it is missing or was
 * revoked is a new one made (and leftovers of the old one removed).
 */
async function discoveryToken(auth: AuthStore, vault: TokenVault): Promise<string> {
  const stored = await vault.load();
  if (stored !== null && (await auth.findToken(stored)) !== undefined) {
    return stored;
  }
  for (const existing of await auth.listTokens()) {
    if (existing.name === DISCOVERY_TOKEN_NAME) {
      await auth.deleteToken(existing.id);
    }
  }
  const { token } = await auth.createToken(DISCOVERY_TOKEN_NAME, ["read", "write"], null);
  await vault.save(token);
  return token;
}

/**
 * Announces this app to Home Assistant, so the integration can be set up with one click. The
 * payload carries an API token made only for this, kept across restarts (see `discoveryToken`).
 */
export async function announceToHomeAssistant(options: DiscoveryOptions): Promise<void> {
  const token = await discoveryToken(options.auth, options.vault);
  const send = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const response = await send(`${SUPERVISOR_URL}/discovery`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      service: DISCOVERY_SERVICE,
      config: { host: hostname(), port: options.port, api_token: token },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    options.logger.warn(
      { status: response.status },
      "Home Assistant did not accept the discovery message.",
    );
    return;
  }
  options.logger.info(
    "Announced to Home Assistant; the integration can now be added from its notification.",
  );
}
