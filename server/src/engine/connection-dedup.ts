import type { Kysely, Transaction } from "kysely";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { appendConnectionRemoved } from "./connections.js";

type Trx = Transaction<Database>;

/** Prefix of the settings rows the Home Assistant importer keeps per imported entry. */
const HA_MARKER_PREFIX = "ha_import:";

/** Moves everything that points at `from` over to `into`, skipping what `into` already has. */
async function moveLinks(trx: Trx, from: string, into: string): Promise<void> {
  await trx
    .insertInto("parcel_connections")
    .columns([
      "parcel_id",
      "connection_id",
      "external_ref",
      "role",
      "last_seen_at",
      "missing_since",
    ])
    .expression((eb) =>
      eb
        .selectFrom("parcel_connections")
        .select([
          "parcel_id",
          eb.val(into).as("connection_id"),
          "external_ref",
          "role",
          "last_seen_at",
          "missing_since",
        ])
        .where("connection_id", "=", from),
    )
    .onConflict((oc) => oc.doNothing())
    .execute();
  await trx
    .updateTable("parcel_events")
    .set({ connection_id: into })
    .where("connection_id", "=", from)
    .execute();
  await trx
    .insertInto("parcel_raw")
    .columns(["parcel_id", "connection_id", "fetched_at", "payload"])
    .expression((eb) =>
      eb
        .selectFrom("parcel_raw")
        .select(["parcel_id", eb.val(into).as("connection_id"), "fetched_at", "payload"])
        .where("connection_id", "=", from),
    )
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/**
 * Points Home Assistant import markers at the surviving connection, marked adopted, so a re-import
 * keeps it as it is instead of creating the duplicate again.
 */
async function moveMarkers(trx: Trx, from: string, into: string): Promise<void> {
  const markers = await trx
    .selectFrom("settings")
    .select(["key", "value"])
    .where("key", "like", `${HA_MARKER_PREFIX}%`)
    .execute();
  for (const marker of markers) {
    const value = JSON.parse(marker.value) as { connectionId?: unknown };
    if (value.connectionId === from) {
      await trx
        .updateTable("settings")
        .set({ value: JSON.stringify({ ...value, connectionId: into, adopted: true }) })
        .where("key", "=", marker.key)
        .execute();
    }
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/**
 * A connection configuration in one spelling, key order aside, so two connections can be compared. Takes
 * the stored JSON text or the parsed value; unreadable text is its own key.
 */
export function configKey(config: unknown): string {
  if (typeof config === "string") {
    try {
      return JSON.stringify(canonical(JSON.parse(config)));
    } catch {
      return `invalid:${config}`;
    }
  }
  return JSON.stringify(canonical(config ?? {}));
}

/**
 * Merges keyless tracking connections of the same provider and the same settings into the oldest one,
 * which keeps its id and label. A keyless tracking connection holds nothing of its own beyond its
 * settings, so two such twins (one created on first use, one imported from Home Assistant) only
 * split the parcels and the polling. Connections whose settings differ (a GLS connection for NL and one
 * for DE, a bpost postcode) are separate lookups and stay apart, and so do connections with a key:
 * each key is its own quota. Idempotent; returns how many were merged.
 */
export async function mergeDuplicateTrackingConnections(
  db: Kysely<Database>,
  clock: Clock,
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("connections")
      .select(["id", "provider", "label", "kind", "config"])
      .where("kind", "=", "tracking")
      .where("secret_blob", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const keep = new Map<string, string>();
    let merged = 0;
    for (const row of rows) {
      const twinKey = JSON.stringify([row.provider, configKey(row.config)]);
      const into = keep.get(twinKey);
      if (into === undefined) {
        keep.set(twinKey, row.id);
        continue;
      }
      await moveLinks(trx, row.id, into);
      await moveMarkers(trx, row.id, into);
      await trx.deleteFrom("connections").where("id", "=", row.id).execute();
      await appendConnectionRemoved(trx, clock, row, into);
      merged += 1;
    }
    return merged;
  });
}
