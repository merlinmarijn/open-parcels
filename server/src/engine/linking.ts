import type { Kysely } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { appendEvent } from "../events/bus.js";
import {
  InvalidConnectionConfigError,
  type ProviderRegistry,
  type RegisteredProvider,
} from "./registry.js";

/** The tracking connection of a carrier, created if missing; undefined when no provider can track it. */
export type TrackingConnectionFor = (carrier: string) => Promise<string | undefined>;

/** True when the provider can run with an empty configuration, so a connection can be made for it. */
export function acceptsEmptyConfig(provider: RegisteredProvider): boolean {
  try {
    provider.validateConfig({});
    return true;
  } catch (error) {
    if (error instanceof InvalidConnectionConfigError) {
      return false;
    }
    throw error;
  }
}

/**
 * The tracking connection of a provider in `db` (which may be a transaction), created on first use and
 * due at once. Undefined when no installed provider can track the carrier, or when its provider needs
 * settings (a postcode, a country) that only the user can give; such parcels stay unfollowed until
 * the user adds the connection, and are linked to it then.
 */
export function trackingConnectionIn(
  db: Kysely<Database>,
  registry: ProviderRegistry,
  clock: Clock,
): TrackingConnectionFor {
  return async (carrier) => {
    const provider = registry.get(carrier);
    if (provider?.canTrack !== true) {
      return undefined;
    }
    const existing = await db
      .selectFrom("connections")
      .select("id")
      .where("provider", "=", carrier)
      .where("kind", "=", "tracking")
      .orderBy("created_at")
      .executeTakeFirst();
    if (existing !== undefined) {
      return existing.id;
    }
    if (provider.info.fallback || !acceptsEmptyConfig(provider)) {
      // GLS, Evri and others need a postcode or a country, and a fallback service is the user's
      // own choice (a service address, an API key): the user has to add the connection.
      return undefined;
    }
    const id = crypto.randomUUID();
    const now = isoNow(clock);
    await db
      .insertInto("connections")
      .values({
        id,
        provider: carrier,
        kind: "tracking",
        label: `${provider.info.name} tracking`,
        config: "{}",
        secret_blob: null,
        session_blob: null,
        state: "ok",
        state_detail: null,
        next_run_at: now,
        // Made by the app, not the user: removed again once its last parcel is deleted.
        auto_created: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    // Clients add the connection's device at once; the caller's next notify delivers it.
    await appendEvent(db, clock, {
      type: "connection.added",
      parcelId: null,
      payload: {
        connection: {
          id,
          provider: carrier,
          label: `${provider.info.name} tracking`,
          kind: "tracking",
        },
        state: "ok",
        detail: null,
      },
    });
    return id;
  };
}

export interface LinkResult {
  readonly connections: ReadonlySet<string>;
  readonly parcels: number;
  /** Carriers whose parcels stayed unfollowed: no provider tracks them, or it needs settings. */
  readonly unlinkedCarriers: ReadonlySet<string>;
}

export interface LinkOptions {
  /** Only parcels linked to this connection (an inbox), as the mail watcher's follow-up does. */
  readonly viaConnection?: string;
}

/**
 * Links every active parcel (undelivered, not archived, not removed) that no carrier connection
 * follows to its carrier's tracking connection, the same link `POST /parcels` makes. Idempotent: a
 * parcel already followed is never touched. Returns the tracking connections that gained parcels and
 * how many parcels were linked.
 */
export async function linkUntrackedParcels(
  db: Kysely<Database>,
  clock: Clock,
  connectionFor: TrackingConnectionFor,
  options: LinkOptions = {},
): Promise<LinkResult> {
  let query = db
    .selectFrom("parcels")
    .select(["parcels.id", "parcels.carrier"])
    .where("parcels.delivered", "=", 0)
    .where("parcels.archived_at", "is", null)
    .where("parcels.removed_at", "is", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("parcel_connections as followed")
            .select("followed.parcel_id")
            .whereRef("followed.parcel_id", "=", "parcels.id")
            .where("followed.role", "in", ["primary", "handoff"]),
        ),
      ),
    );
  if (options.viaConnection !== undefined) {
    const via = options.viaConnection;
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom("parcel_connections as via")
          .select("via.parcel_id")
          .whereRef("via.parcel_id", "=", "parcels.id")
          .where("via.connection_id", "=", via),
      ),
    );
  }
  const unfollowed = await query.execute();
  const touched = new Set<string>();
  const unlinked = new Set<string>();
  let parcels = 0;
  const byCarrier = new Map<string, string | undefined>();
  for (const parcel of unfollowed) {
    if (!byCarrier.has(parcel.carrier)) {
      byCarrier.set(parcel.carrier, await connectionFor(parcel.carrier));
    }
    const connectionId = byCarrier.get(parcel.carrier);
    if (connectionId === undefined) {
      unlinked.add(parcel.carrier);
      continue;
    }
    await db
      .insertInto("parcel_connections")
      .values({
        parcel_id: parcel.id,
        connection_id: connectionId,
        external_ref: null,
        role: "primary",
        last_seen_at: isoNow(clock),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    touched.add(connectionId);
    parcels += 1;
  }
  return { connections: touched, parcels, unlinkedCarriers: unlinked };
}
