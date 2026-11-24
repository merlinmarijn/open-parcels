import { createDecipheriv } from "node:crypto";
import SQLite from "better-sqlite3";
import type { Kysely, Transaction } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import { DecryptionError, type SecretBox } from "../crypto/secrets.js";
import type { Database } from "../db/schema.js";
import { isPlausibleOrder, shopFromDomain } from "../domain/order.js";
import type { ParcelStatus } from "../domain/parcel.js";
import { normaliseTrackingNumber } from "../engine/tracking-number.js";
import { BUILTIN_CARRIERS } from "../engine/builtin-carriers.js";
import { linkUntrackedParcels, trackingConnectionIn } from "../engine/linking.js";
import { ProviderRegistry } from "../engine/registry.js";
import { secretAad } from "../engine/connections.js";
import { appendEvent } from "../events/bus.js";
import { MAIL_PROVIDER, mailConfigSchema, mailSecretSchema, inboxLabel } from "../mail/types.js";
import { fixesCarrier, resolveLegacyCarrier } from "./legacy-carrier.js";
import { DELIBERATELY_SKIPPED, isMailService, parseLegacyImap, serviceKey } from "./legacy-imap.js";

export { carrierId, resolveLegacyCarrier } from "./legacy-carrier.js";

/** Statuses of the pre-rewrite app, mapped to the canonical list. */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  ordered: "registered",
  pending: "registered",
  registered: "registered",
  sent: "in_transit",
  shipped: "in_transit",
  dispatched: "in_transit",
  in_transit: "in_transit",
  // "arriving" covered both "today" and later days; the first poll after the import corrects it.
  arriving: "in_transit",
  out_for_delivery: "out_for_delivery",
  ready_for_pickup: "at_pickup_point",
  delivered: "delivered",
  exception: "problem",
  failed: "problem",
  return: "returning",
  returned: "returning",
  unknown: "unknown",
};

export interface LegacyReport {
  readonly dryRun: boolean;
  readonly orders: number;
  readonly parcels: number;
  readonly skippedDuplicateParcels: number;
  readonly events: number;
  readonly droppedPositionEvents: number;
  readonly inboxes: number;
  /** Inboxes already present (same host and user), from an earlier import or added by hand. */
  readonly skippedDuplicateMailboxes: number;
  /** Active parcels linked to their carrier's tracking connection, so they get refreshed. */
  readonly linkedParcels: number;
  /** Parcels from an earlier import whose placeholder carrier was replaced by a provider id. */
  readonly correctedCarriers: number;
  /** Imported parcels per provider id; `unknown` only when nothing identified the carrier. */
  readonly carriers: Readonly<Record<string, number>>;
  /** Stored credentials that were not imported, each with the reason (e.g. Amazon: sign in again). */
  readonly skippedCredentials: readonly SkippedCredential[];
  readonly undecryptableCredentials: number;
  /** Setting keys found in the old database; their values are not carried over. */
  readonly settingKeys: readonly string[];
  readonly statuses: Readonly<Record<string, number>>;
}

export interface SkippedCredential {
  readonly service: string;
  readonly reason: string;
}

export interface LegacyImportOptions {
  readonly legacyPath: string;
  readonly db: Kysely<Database>;
  readonly secrets: SecretBox;
  readonly clock: Clock;
  /** The old ENCRYPTION_KEY (64 hex characters); without it no credentials are imported. */
  readonly legacyKeyHex: string | undefined;
  readonly dryRun: boolean;
}

class DryRunRollback extends Error {
  override readonly name = "DryRunRollback";
}

type Row = Record<string, unknown>;

/** Old timestamps are Unix seconds (milliseconds in a few rows); returns ISO or null. */
function toIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value > 1e12 ? value : value * 1000).toISOString();
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // Unreadable stored JSON counts as nothing; the caller's schema check then fails.
    return undefined;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function decryptLegacy(encrypted: string, key: Buffer): string {
  const [iv, tag, body] = encrypted.split(":");
  if (iv === undefined || tag === undefined || body === undefined) {
    throw new Error("Unknown credential format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return decipher.update(body, "hex", "utf8") + decipher.final("utf8");
}

function columns(legacy: SQLite.Database, table: string): Set<string> {
  const info = legacy.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  return new Set(info.map((column) => column.name));
}

function readAll(legacy: SQLite.Database, table: string): Row[] {
  return columns(legacy, table).size === 0
    ? []
    : (legacy.prepare(`select * from ${table}`).all() as Row[]);
}

interface Counters {
  orders: number;
  parcels: number;
  skippedDuplicateParcels: number;
  events: number;
  droppedPositionEvents: number;
  inboxes: number;
  skippedDuplicateMailboxes: number;
  linkedParcels: number;
  correctedCarriers: number;
  undecryptableCredentials: number;
  statuses: Record<string, number>;
  carriers: Record<string, number>;
}

interface ImportedOrder {
  /** Null when the user deleted the order here: its shop still helps to name the carrier. */
  readonly id: string | null;
  readonly shop: string;
}

/** Shops named by the old parcels' names ("example-shop.de"), per old order id. */
function shopsFromLabels(parcels: readonly Row[]): Map<string, string> {
  const shops = new Map<string, string>();
  for (const parcel of parcels) {
    const shop = shopFromDomain(text(parcel["name"]));
    const orderId = parcel["order_id"];
    if (shop !== null && typeof orderId === "string") {
      shops.set(orderId, shop);
    }
  }
  return shops;
}

/**
 * The old app's shop. It named a shop after anything its mail parser recognised (a mail paid with
 * Amazon Pay became an Amazon order), so a number that cannot be that shop's falls back to the
 * shop its parcel was named after, else `unknown`.
 */
function legacyShop(row: Row, orderNumber: string, labelShops: ReadonlyMap<string, string>) {
  const named = text(row["source"] ?? row["shop"])?.toLowerCase() ?? "unknown";
  return isPlausibleOrder(named, orderNumber)
    ? named
    : (labelShops.get(String(row["id"])) ?? "unknown");
}

async function importOrders(
  trx: Transaction<Database>,
  rows: readonly Row[],
  labelShops: ReadonlyMap<string, string>,
  context: { now: string; counters: Counters },
): Promise<Map<string, ImportedOrder>> {
  const { now, counters } = context;
  const ids = new Map<string, ImportedOrder>();
  for (const row of rows) {
    const orderNumber = text(row["order_number"]);
    if (orderNumber === null) {
      continue;
    }
    const shop = legacyShop(row, orderNumber, labelShops);
    const existing = await trx
      .selectFrom("orders")
      .select(["id", "deleted_at"])
      .where("shop", "=", shop)
      .where("order_number", "=", orderNumber)
      .executeTakeFirst();
    if (existing !== undefined && existing.deleted_at !== null) {
      // The user deleted this order: its parcels come over without one, never under the tombstone.
      ids.set(String(row["id"]), { id: null, shop });
      continue;
    }
    const id = existing?.id ?? crypto.randomUUID();
    if (existing === undefined) {
      await trx
        .insertInto("orders")
        .values({
          id,
          shop,
          order_number: orderNumber,
          placed_at: toIso(row["placed_at"]),
          status: text(row["status"]),
          created_at: toIso(row["added_at"]) ?? now,
          updated_at: toIso(row["updated_at"]) ?? now,
        })
        .execute();
      counters.orders += 1;
    }
    ids.set(String(row["id"]), { id, shop });
  }
  return ids;
}

async function importParcels(
  trx: Transaction<Database>,
  rows: readonly Row[],
  orders: ReadonlyMap<string, ImportedOrder>,
  now: string,
  counters: Counters,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const row of rows) {
    const trackingNumber = text(row["tracking_number"]);
    if (trackingNumber === null) {
      continue;
    }
    const order = orders.get(String(row["order_id"]));
    const carrier = resolveLegacyCarrier({
      courier: row["courier"],
      trackingNumber,
      shop: order?.shop ?? null,
    });
    counters.carriers[carrier] = (counters.carriers[carrier] ?? 0) + 1;
    const oldStatus = text(row["status"])?.toLowerCase() ?? "unknown";
    const status = STATUS_MAP[oldStatus] ?? "unknown";
    counters.statuses[`${oldStatus} → ${status}`] =
      (counters.statuses[`${oldStatus} → ${status}`] ?? 0) + 1;
    const stored = normaliseTrackingNumber(carrier, trackingNumber);
    const existing = await trx
      .selectFrom("parcels")
      .select(["id", "carrier"])
      .where("tracking_number", "in", [...new Set([trackingNumber, stored])])
      .execute();
    if (existing.length > 0) {
      counters.skippedDuplicateParcels += 1;
      // An earlier import that left a placeholder carrier ("unknown", "china") is corrected.
      const [only] = existing;
      if (existing.length === 1 && only !== undefined && fixesCarrier(only.carrier, carrier)) {
        await trx.updateTable("parcels").set({ carrier }).where("id", "=", only.id).execute();
        counters.correctedCarriers += 1;
      }
      continue;
    }
    const id = crypto.randomUUID();
    const delivered = status === "delivered";
    const updatedAt = toIso(row["updated_at"]) ?? now;
    await trx
      .insertInto("parcels")
      .values({
        id,
        carrier,
        tracking_number: stored,
        direction: "receiving",
        status,
        raw_status: text(row["last_event_description"]),
        delivered: delivered ? 1 : 0,
        delivered_at: delivered ? updatedAt : null,
        expected_from: delivered ? null : toIso(row["estimated_delivery_start"]),
        expected_to: delivered ? null : toIso(row["estimated_delivery_end"]),
        pickup: status === "at_pickup_point" ? 1 : 0,
        label: text(row["name"]),
        order_id: order?.id ?? null,
        // A status the user set by hand stays theirs.
        manual_status: row["is_manual_status"] === 1 ? status : null,
        first_seen_at: toIso(row["added_at"]) ?? now,
        last_seen_at: updatedAt,
        updated_at: updatedAt,
      })
      .execute();
    ids.set(String(row["id"]), id);
    counters.parcels += 1;
  }
  return ids;
}

async function importEvents(
  trx: Transaction<Database>,
  rows: readonly Row[],
  parcelIds: ReadonlyMap<string, string>,
  counters: Counters,
): Promise<void> {
  for (const row of rows) {
    const parcelId = parcelIds.get(String(row["parcel_id"]));
    const at = toIso(row["timestamp"]);
    const description = text(row["description"]);
    // Rows written by the old live scraper were courier positions; positions are never history.
    // Only the scraper's own names (`live`, `amazon-live`), never a connection that merely contains
    // the letters (`delivery`, `delivered`).
    if (/(?:^|[-_])live$/i.test(text(row["source"]) ?? "")) {
      counters.droppedPositionEvents += 1;
      continue;
    }
    if (parcelId === undefined || at === null || description === null) {
      continue;
    }
    const location = text(row["location"]);
    const [inserted] = await trx
      .insertInto("parcel_events")
      .values({
        parcel_id: parcelId,
        connection_id: null,
        at,
        status: null,
        raw_status: description,
        location_text: location,
        fingerprint: `legacy-${String(row["id"])}`,
      })
      .onConflict((oc) => oc.columns(["parcel_id", "fingerprint"]).doNothing())
      .execute();
    // A re-run inserts nothing for rows it imported before.
    counters.events += Number(inserted?.numInsertedOrUpdatedRows ?? 0n);
  }
}

interface ImportCredentials {
  readonly trx: Transaction<Database>;
  readonly rows: readonly Row[];
  readonly key: Buffer | undefined;
  readonly secrets: SecretBox;
  readonly clock: Clock;
  readonly now: string;
  /** Inbox settings the old app kept outside the credential (imap_host, imap_port, ...). */
  readonly settings: Readonly<Record<string, unknown>>;
}

/** Why a credential row is not imported before decrypting it, or null to go on. */
function skipReason(service: string, key: Buffer | undefined, encrypted: string | null) {
  const deliberate = DELIBERATELY_SKIPPED[serviceKey(service)];
  if (deliberate !== undefined) {
    return deliberate;
  }
  if (!isMailService(service)) {
    return "No connection type takes this service's stored credentials; add it again by hand.";
  }
  if (encrypted === null) {
    return "The credential row is empty.";
  }
  return key === undefined ? "No old key given (OPENPARCELS_LEGACY_KEY)." : null;
}

/**
 * The decrypted credential: JSON, or a bare `user:password@host:port` string. The server is after
 * the last `@` and the user before the first `:`, so an email address as the user and a password
 * holding `@` or `:` both read correctly.
 */
export function parseDecrypted(plain: string): unknown {
  try {
    return JSON.parse(plain) as unknown;
  } catch {
    const value = plain.trim().replace(/^imaps?:\/\//i, "");
    const at = value.lastIndexOf("@");
    const login = value.slice(0, Math.max(at, 0));
    const colon = login.indexOf(":");
    const server = /^([^\s:/@]+)(?::(\d+))?\/?$/.exec(value.slice(at + 1));
    if (at < 0 || colon <= 0 || colon === login.length - 1 || server === null) {
      return plain;
    }
    return {
      user: login.slice(0, colon),
      password: login.slice(colon + 1),
      host: server[1],
      port: server[2],
    };
  }
}

async function importCredentials(
  input: ImportCredentials,
  counters: Counters,
  skipped: SkippedCredential[],
): Promise<void> {
  for (const row of input.rows) {
    const service = text(row["service"] ?? row["type"] ?? row["name"]) ?? "unknown";
    const encrypted = text(row["encrypted_data"] ?? row["data"] ?? row["value"]);
    const reason = skipReason(service, input.key, encrypted);
    if (reason !== null || input.key === undefined || encrypted === null) {
      skipped.push({ service, reason: reason ?? "No credential." });
      continue;
    }
    let plain: string;
    try {
      plain = decryptLegacy(encrypted, input.key);
    } catch {
      // Wrong key or damaged data: counted and named in the report; it can be added by hand.
      counters.undecryptableCredentials += 1;
      skipped.push({ service, reason: "It cannot be decrypted with the old key given." });
      continue;
    }
    const decrypted = parseDecrypted(plain);
    // Some versions kept a list of inboxes under one credential.
    for (const record of Array.isArray(decrypted) ? decrypted : [decrypted]) {
      const parsed = parseLegacyImap(record, input.settings);
      if (!parsed.ok) {
        skipped.push({ service, reason: parsed.reason });
        continue;
      }
      if (await insertMailbox(input, parsed.config, parsed.secret)) {
        counters.inboxes += 1;
      } else {
        counters.skippedDuplicateMailboxes += 1;
      }
    }
  }
}

/** True when an inbox connection for this host and user already exists. */
async function hasMailbox(
  input: ImportCredentials,
  host: string,
  username: string,
): Promise<boolean> {
  const rows = await input.trx
    .selectFrom("connections")
    .select(["id", "config", "secret_blob"])
    .where("provider", "=", MAIL_PROVIDER)
    .where("kind", "=", "mail")
    .execute();
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
  return rows.some((row) => {
    const config = mailConfigSchema.safeParse(parseJson(row.config));
    if (!config.success || !same(config.data.host, host) || row.secret_blob === null) {
      return false;
    }
    let stored: unknown;
    try {
      stored = input.secrets.decryptJson(row.secret_blob, secretAad(row.id));
    } catch (error) {
      if (!(error instanceof DecryptionError)) {
        throw error;
      }
      // An inbox whose sign-in this key cannot read is not the same one; it never aborts the
      // whole import.
      return false;
    }
    const secret = mailSecretSchema.safeParse(stored);
    return secret.success && same(secret.data.username, username);
  });
}

/** Adds the inbox unless one for the same host and user exists; true when it was added. */
async function insertMailbox(
  input: ImportCredentials,
  config: { host: string },
  secret: { username: string; password: string },
): Promise<boolean> {
  if (await hasMailbox(input, config.host, secret.username)) {
    return false;
  }
  const id = crypto.randomUUID();
  const label = inboxLabel(secret.username, config.host);
  await input.trx
    .insertInto("connections")
    .values({
      id,
      provider: MAIL_PROVIDER,
      kind: "mail",
      label,
      config: JSON.stringify(config),
      secret_blob: input.secrets.encryptJson(secret, secretAad(id)),
      session_blob: null,
      state: "ok",
      state_detail: null,
      next_run_at: null,
      created_at: input.now,
      updated_at: input.now,
    })
    .execute();
  // Clients add the inbox's device when the running server next delivers events.
  await appendEvent(input.trx, input.clock, {
    type: "connection.added",
    parcelId: null,
    payload: {
      connection: { id, provider: MAIL_PROVIDER, label, kind: "mail" },
      state: "ok",
      detail: null,
    },
  });
  return true;
}

/** Old settings whose key mentions IMAP or mail, values decoded from JSON where possible. */
function mailSettings(rows: readonly Row[]): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    const key = String(row["key"]);
    const match = /^(?:imap|mail|email)[._-]?(.+)$/i.exec(key);
    if (match?.[1] === undefined) {
      continue;
    }
    const raw = row["value"];
    let value: unknown = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        value = raw;
      }
    }
    settings[match[1]] = value;
  }
  return settings;
}

/**
 * Imports the pre-rewrite database. The old file is opened read-only and never changed. A dry run
 * performs the whole import inside a transaction and rolls it back, so it validates everything.
 */
export async function importLegacy(options: LegacyImportOptions): Promise<LegacyReport> {
  const legacy = new SQLite(options.legacyPath, { readonly: true, fileMustExist: true });
  const key =
    options.legacyKeyHex === undefined ? undefined : Buffer.from(options.legacyKeyHex, "hex");
  if (key !== undefined && key.length !== 32) {
    legacy.close();
    throw new Error("The old encryption key must be 64 hex characters.");
  }
  const counters: Counters = {
    orders: 0,
    parcels: 0,
    skippedDuplicateParcels: 0,
    events: 0,
    droppedPositionEvents: 0,
    inboxes: 0,
    skippedDuplicateMailboxes: 0,
    linkedParcels: 0,
    correctedCarriers: 0,
    undecryptableCredentials: 0,
    statuses: {},
    carriers: {},
  };
  const skipped: SkippedCredential[] = [];
  let settingKeys: string[] = [];
  try {
    const settingRows = readAll(legacy, "settings");
    settingKeys = settingRows.map((row) => String(row["key"]));
    await options.db.transaction().execute(async (trx) => {
      const now = isoNow(options.clock);
      const legacyParcels = readAll(legacy, "parcels");
      const orders = await importOrders(
        trx,
        readAll(legacy, "orders"),
        shopsFromLabels(legacyParcels),
        { now, counters },
      );
      const parcelIds = await importParcels(trx, legacyParcels, orders, now, counters);
      await importEvents(trx, readAll(legacy, "parcel_events"), parcelIds, counters);
      await importCredentials(
        {
          trx,
          rows: readAll(legacy, "credentials"),
          key,
          secrets: options.secrets,
          clock: options.clock,
          now,
          settings: mailSettings(settingRows),
        },
        counters,
        skipped,
      );
      // Active parcels are followed by their carrier's tracking connection, as `POST /parcels` does;
      // the connections are due at once, so the first poll after start refreshes them.
      const linked = await linkUntrackedParcels(
        trx,
        options.clock,
        trackingConnectionIn(trx, new ProviderRegistry(BUILTIN_CARRIERS), options.clock),
      );
      counters.linkedParcels = linked.parcels;
      if (options.dryRun) {
        throw new DryRunRollback("Dry run: rolling back.");
      }
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) {
      throw error;
    }
  } finally {
    legacy.close();
  }
  return {
    dryRun: options.dryRun,
    ...counters,
    skippedCredentials: skipped.sort((a, b) => a.service.localeCompare(b.service)),
    settingKeys: settingKeys.sort(),
  };
}
