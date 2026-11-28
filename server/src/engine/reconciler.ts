import { createHash } from "node:crypto";
import { newParcelRow } from "../parcels/new-row.js";
import type { Kysely, Transaction } from "kysely";
import type { Logger } from "pino";
import { addMs, isoNow, type Clock } from "../clock.js";
import type { Database, ParcelRow, ConnectionRow } from "../db/schema.js";
import {
  effectiveStatus,
  parseStatus,
  statusOrUnknown,
  type ParcelStatus,
} from "../domain/parcel.js";
import { appendEvent, type EventBus } from "../events/bus.js";
import { parcelEventPayload } from "../events/payload.js";
import { ParcelRepository, RAW_PRESENTATION, type Presentation } from "../parcels/repository.js";
import type { FetchResult, LiveTarget } from "../provider/api.js";
import type { ParcelSnapshot, SnapshotEvent } from "../provider/snapshot.js";
import { healState, mergeParcel, type Authority, type ParcelState } from "./merge.js";
import { deriveEvents, type EventView } from "./rules.js";
import { utcSnapshot } from "./utc.js";
import { normaliseTrackingNumber } from "./tracking-number.js";
import {
  adoptShopTwin,
  findParcel,
  foldShopDuplicate,
  foldStoredTwins,
  withInferredHandoff,
  type TwinEnv,
} from "./twins.js";
import { scrubRaw } from "./raw-scrub.js";
import { foldSuperseded } from "./superseded.js";
import { withSafeLinks } from "./links.js";
import { sameRows, writeOrderItems } from "./order-items.js";
import { createOrder, findOrder } from "./order-rows.js";
import { applyReturns } from "./returns.js";
import { applyOrders } from "./orders.js";
import { closeImport, deliveredLongAgo, lastSeq } from "./imported.js";
import { OrderService } from "../orders/service.js";
import { ReturnService } from "../returns/service.js";
import { maskIdentifiers, recordUnknown, type UnknownValue } from "./vocab.js";

/** A parcel missing from every complete listing for this long, undelivered, counts as removed. */
const REMOVAL_GRACE_MS = 6 * 60 * 60 * 1000;

type Trx = Transaction<Database>;

export interface LiveTargetOfParcel {
  readonly parcelId: string;
  readonly target: LiveTarget;
}

export interface IngestSummary {
  readonly created: number;
  readonly updated: number;
  readonly events: number;
  /** Parcels the carrier can show on a courier map; handed to the live tracker, never stored. */
  readonly liveTargets: readonly LiveTargetOfParcel[];
  /** Parcels a tracking run asked the carrier about, and how many of them it returned. */
  readonly asked: number;
  readonly found: number;
}

function rowToState(row: ParcelRow): ParcelState {
  return {
    direction: row.direction,
    status: statusOrUnknown(row.status),
    rawStatus: row.raw_status,
    statusAt: row.status_at,
    delivered: row.delivered === 1,
    deliveredAt: row.delivered_at,
    expectedFrom: row.expected_from,
    expectedTo: row.expected_to,
    pickup: row.pickup === 1,
    pickupPoint: row.pickup_point,
    url: row.url,
    sender: row.sender,
    receiver: row.receiver,
    weightKg: row.weight_kg,
  };
}

function eventView(state: ParcelState, manualStatus: ParcelStatus | null): EventView {
  return {
    direction: state.direction,
    status: effectiveStatus({ status: state.status, manual_status: manualStatus }),
    delivered: manualStatus === null ? state.delivered : manualStatus === "delivered",
    expectedFrom: state.expectedFrom,
    expectedTo: state.expectedTo,
  };
}

function stateColumns(state: ParcelState) {
  return {
    status: state.status,
    raw_status: state.rawStatus,
    status_at: state.statusAt,
    delivered: state.delivered ? (1 as const) : (0 as const),
    delivered_at: state.deliveredAt,
    expected_from: state.expectedFrom,
    expected_to: state.expectedTo,
    pickup: state.pickup ? (1 as const) : (0 as const),
    pickup_point: state.pickupPoint,
    url: state.url,
    sender: state.sender,
    receiver: state.receiver,
    weight_kg: state.weightKg,
  };
}

/** An entry's identity: the connection's own id when it has one, else time, text and place. */
export function fingerprint(
  event: Pick<SnapshotEvent, "at" | "rawStatus" | "location" | "id">,
): string {
  const basis =
    event.id === undefined
      ? `${event.at}\u0000${event.rawStatus}\u0000${event.location ?? ""}`
      : `id\u0000${event.id}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

/** An event's position, only when both halves are real coordinates. */
function coordinates(event: SnapshotEvent): { latitude: number | null; longitude: number | null } {
  const { latitude, longitude } = event;
  const valid =
    latitude !== undefined &&
    longitude !== undefined &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180;
  return valid ? { latitude, longitude } : { latitude: null, longitude: null };
}

/**
 * A mail whose wording no rule maps, recorded so it can be added to the rules. Identifiers in the
 * subject are masked; the carrier goes in the provider column so the right table is obvious.
 */
function unmappedMail(snapshot: ParcelSnapshot): UnknownValue | null {
  const raw = snapshot.rawStatus;
  if (snapshot.status !== null || snapshot.delivered || raw === null) {
    return null;
  }
  const key = maskIdentifiers(raw);
  return key === "" ? null : { provider: snapshot.carrier, kind: "mail_subject", key };
}

/** The snapshot's codes in their stored spelling, so an echoed `1Z999…` finds `1z 999…`. */
function normalisedCodes(snapshot: ParcelSnapshot): ParcelSnapshot {
  return {
    ...snapshot,
    trackingNumber: normaliseTrackingNumber(snapshot.carrier, snapshot.trackingNumber),
    handoff:
      snapshot.handoff === null
        ? null
        : {
            carrier: snapshot.handoff.carrier,
            trackingNumber: normaliseTrackingNumber(
              snapshot.handoff.carrier,
              snapshot.handoff.trackingNumber,
            ),
          },
  };
}

/** The parcel's stored history from every connection, as merge input. */
async function storedHistory(trx: Trx, parcelId: string): Promise<SnapshotEvent[]> {
  const rows = await trx
    .selectFrom("parcel_events")
    .select(["at", "status", "raw_status", "location_text"])
    .where("parcel_id", "=", parcelId)
    .execute();
  return rows.map((row) => ({
    at: row.at,
    status: parseStatus(row.status),
    rawStatus: row.raw_status,
    location: row.location_text,
  }));
}

/**
 * The only writer of carrier data. Turns provider snapshots into stored parcels and canonical
 * events, in one transaction per connection run.
 */
export class Reconciler {
  private readonly presentation: Presentation;
  /** The server's zone: return-by days are local days. */
  private readonly timeZone: string;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly logger: Logger,
    options: { readonly presentation?: Presentation; readonly timeZone?: string } = {},
  ) {
    this.presentation = options.presentation ?? RAW_PRESENTATION;
    this.timeZone = options.timeZone ?? "UTC";
  }

  #twinEnv(): TwinEnv {
    return { clock: this.clock, presentation: this.presentation, logger: this.logger };
  }

  /**
   * Applies one connection run. `asked` lists the parcels a tracking run asked the carrier about;
   * each is marked found or not found, so a code the carrier does not know is visible on the
   * parcel (`lookup`) instead of silently staying `registered`. No event fires for it.
   */
  async ingest(
    connectionId: string,
    result: FetchResult,
    asked: readonly string[] = [],
    /** `imported`: an import job's batch, stored as history (`./imported.ts`). */
    options: { readonly imported?: boolean } = {},
  ): Promise<IngestSummary> {
    const connection = await this.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", connectionId)
      .executeTakeFirst();
    const summary = {
      created: 0,
      updated: 0,
      events: 0,
      liveTargets: [] as LiveTargetOfParcel[],
      asked: asked.length,
      found: 0,
    };
    if (connection === undefined) {
      // Deleted by the user while this run was fetching: nothing of its answer is kept.
      return summary;
    }
    const unknown: UnknownValue[] = [];
    await this.db.transaction().execute(async (trx) => {
      const seen = new Set<string>();
      const importedAt = options.imported === true ? isoNow(this.clock) : null;
      const since = importedAt === null ? 0 : await lastSeq(trx);
      let archived = 0;
      const apply = async (parcel: ParcelSnapshot) => {
        const outcome = await this.#applySnapshot(trx, connection, parcel, importedAt);
        archived += outcome.archived ? 1 : 0;
        return outcome;
      };
      const trackParcel = async (parcel: ParcelSnapshot): Promise<string> =>
        (await apply(withSafeLinks(normalisedCodes(parcel)))).parcelId;
      const env = {
        clock: this.clock,
        importedAt,
        timeZone: this.timeZone,
        trackParcel,
        orderView: (inner: Trx, id: string) =>
          new OrderService(
            inner,
            this.bus,
            this.clock,
            this.presentation,
            new ReturnService(inner, this.clock, this.timeZone),
          ).get(id),
      };
      // Orders first, so an order an email starts is announced as created before its parcels.
      summary.events += await applyOrders(trx, env, connection.id, result.orders ?? []);
      for (const reported of result.snapshots) {
        const snapshot = withSafeLinks(normalisedCodes(utcSnapshot(reported)));
        const value = connection.kind === "mail" ? unmappedMail(snapshot) : null;
        if (value !== null) {
          unknown.push(value);
        }
        const outcome = await apply(snapshot);
        seen.add(outcome.parcelId);
        if (snapshot.live !== null) {
          summary.liveTargets.push({ parcelId: outcome.parcelId, target: snapshot.live });
        }
        summary[outcome.created ? "created" : "updated"] += 1;
        summary.events += outcome.events;
      }
      if (connection.kind === "shop") {
        await foldSuperseded(trx, this.#twinEnv(), connection.id, seen);
      }
      // A tracking connection only answers for the codes it was asked about. Whether such a code is
      // gone is the not-found lookup state's call (archived after 30 days, ADR §2.5), never
      // `parcel.removed`, whatever the provider says about completeness.
      if (result.complete && connection.kind !== "tracking") {
        await this.#markMissing(trx, connectionId, seen);
      }
      summary.found = await this.#recordLookup(trx, asked, seen);
      summary.events += await applyReturns(trx, env, connection.id, result.returns ?? []);
      if (importedAt !== null) {
        const { created, updated } = summary;
        const orders = result.orders?.length ?? 0;
        await closeImport(trx, this.clock, since, connection, {
          created,
          updated,
          archived,
          orders,
        });
      }
    });
    await this.bus.notify();
    const vocab = { db: this.db, bus: this.bus, clock: this.clock };
    for (const value of unknown) {
      // Recording is best effort; the parcels are already stored.
      await recordUnknown(vocab, value, this.logger).catch((error: unknown) => {
        this.logger.error({ err: error }, "Recording an unrecognised value failed.");
      });
    }
    summary.events += await this.judgeRemovals();
    return summary;
  }

  /**
   * Repairs parcels stored under the old merge rules (`unknown` while a stored entry maps, or
   * delivered in status only), from their stored history. Idempotent; run at startup.
   */
  async repair(): Promise<number> {
    const twins = await this.db
      .transaction()
      .execute((trx) => foldStoredTwins(trx, this.#twinEnv()));
    if (twins > 0) {
      await this.bus.notify();
      this.logger.info({ folded: twins }, "Folded shop parcels into their carriers' parcels.");
    }
    const candidates = await this.db
      .selectFrom("parcels")
      .select("id")
      .where((eb) =>
        eb.or([
          eb("status", "=", "unknown"),
          eb.and([eb("status", "=", "delivered"), eb("delivered", "=", 0)]),
        ]),
      )
      .execute();
    let repaired = 0;
    await this.db.transaction().execute(async (trx) => {
      for (const { id } of candidates) {
        repaired += (await this.#repairOne(trx, id)) ? 1 : 0;
      }
    });
    if (repaired > 0) {
      await this.bus.notify();
      this.logger.info({ repaired }, "Repaired parcel statuses from their stored history.");
    }
    return repaired;
  }

  async #repairOne(trx: Trx, parcelId: string): Promise<boolean> {
    const row = await trx
      .selectFrom("parcels")
      .selectAll()
      .where("id", "=", parcelId)
      .executeTakeFirstOrThrow();
    const before = rowToState(row);
    const after = healState(before, await storedHistory(trx, parcelId));
    if (after === null) {
      return false;
    }
    await trx
      .updateTable("parcels")
      .set({ ...stateColumns(after), updated_at: isoNow(this.clock) })
      .where("id", "=", parcelId)
      .execute();
    const manual = parseStatus(row.manual_status);
    const derived = deriveEvents(eventView(before, manual), eventView(after, manual));
    const parcel =
      derived.length === 0
        ? undefined
        : await new ParcelRepository(trx, this.presentation).get(parcelId);
    if (parcel === undefined) {
      return true;
    }
    for (const event of derived) {
      await appendEvent(trx, this.clock, {
        type: event.type,
        parcelId,
        payload: parcelEventPayload(parcel, event.changes),
      });
    }
    return true;
  }

  async #applySnapshot(
    trx: Trx,
    connection: ConnectionRow,
    reported: ParcelSnapshot,
    importedAt: string | null,
  ): Promise<{ parcelId: string; created: boolean; events: number; archived: boolean }> {
    const snapshot = await withInferredHandoff(trx, connection, reported);
    if (snapshot.handoff === null && connection.kind !== "shop" && connection.kind !== "mail") {
      await adoptShopTwin(trx, this.#twinEnv(), snapshot);
    }
    const key = snapshot.handoff ?? {
      carrier: snapshot.carrier,
      trackingNumber: snapshot.trackingNumber,
    };
    const authority: Authority =
      snapshot.handoff === null && connection.kind !== "mail" ? "carrier" : "secondary";
    const role =
      snapshot.handoff !== null ? "handoff" : connection.kind === "mail" ? "mail" : "primary";
    const now = isoNow(this.clock);

    let existing = await findParcel(trx, key.carrier, key.trackingNumber);
    if (snapshot.handoff !== null) {
      existing = await foldShopDuplicate(trx, this.#twinEnv(), snapshot, existing);
    }
    const before = existing === undefined ? null : rowToState(existing);
    const manual = existing === undefined ? null : parseStatus(existing.manual_status);
    const merged = mergeParcel(
      before,
      { ...snapshot, carrier: key.carrier, trackingNumber: key.trackingNumber },
      authority,
      existing === undefined ? [] : await storedHistory(trx, existing.id),
    );
    // A delivery nobody gave a time for is dated when it was first seen, so retention (which
    // counts from delivered_at) archives it like any other.
    const after =
      merged.delivered && merged.deliveredAt === null ? { ...merged, deliveredAt: now } : merged;
    const parcelId = existing?.id ?? crypto.randomUUID();
    const orderId = await this.#upsertOrder(trx, snapshot, now, importedAt);
    // Imported and delivered long ago: history, stored archived and announced by nobody.
    const archived =
      existing === undefined && importedAt !== null && deliveredLongAgo(after, this.clock.now());
    if (orderId !== null) {
      await trx
        .insertInto("order_connections")
        .values({ order_id: orderId, connection_id: connection.id })
        .onConflict((oc) => oc.columns(["order_id", "connection_id"]).doNothing())
        .execute();
    }

    if (existing === undefined) {
      await trx
        .insertInto("parcels")
        .values(
          newParcelRow(
            {
              id: parcelId,
              carrier: key.carrier,
              trackingNumber: key.trackingNumber,
              direction: after.direction,
              now,
            },
            {
              ...stateColumns(after),
              order_id: orderId,
              imported_at: importedAt,
              archived_at: archived ? now : null,
            },
          ),
        )
        .execute();
    } else {
      await trx
        .updateTable("parcels")
        .set({
          ...stateColumns(after),
          order_id: orderId ?? existing.order_id,
          last_seen_at: now,
          updated_at: now,
          removed_at: null,
        })
        .where("id", "=", parcelId)
        .execute();
    }
    await this.#writeRelated(trx, {
      parcelId,
      connectionId: connection.id,
      connectionKind: connection.kind,
      role,
      snapshot,
      now,
    });
    if (orderId !== null) {
      await writeOrderItems(trx, orderId, parcelId, snapshot);
    }

    const derived = archived
      ? []
      : deriveEvents(before === null ? null : eventView(before, manual), eventView(after, manual));
    if (derived.length > 0) {
      const parcel = await new ParcelRepository(trx, this.presentation).get(parcelId);
      for (const event of derived) {
        if (parcel !== undefined) {
          await appendEvent(trx, this.clock, {
            type: event.type,
            parcelId,
            payload: parcelEventPayload(parcel, event.changes),
          });
        }
      }
    }
    return { parcelId, created: existing === undefined, events: derived.length, archived };
  }

  async #upsertOrder(
    trx: Trx,
    snapshot: ParcelSnapshot,
    now: string,
    importedAt: string | null,
  ): Promise<string | null> {
    if (snapshot.order === null) {
      return null;
    }
    const existing = await findOrder(trx, snapshot.order);
    // The owner deleted the order: its parcels stay tracked, without it.
    if (existing !== undefined && existing.deleted_at !== null) {
      return null;
    }
    if (existing !== undefined) {
      // A connection that names the order without its date (a mail) never erases the shop's date,
      // and an unchanged date is no change.
      const placedAt = snapshot.order.placedAt;
      if (placedAt !== null) {
        await trx
          .updateTable("orders")
          .set({ placed_at: placedAt, updated_at: now })
          .where("id", "=", existing.id)
          .where((eb) => eb.or([eb("placed_at", "is", null), eb("placed_at", "!=", placedAt)]))
          .execute();
      }
      const returnUntil = snapshot.order.returnUntil ?? null;
      if (returnUntil !== null) {
        await trx
          .updateTable("orders")
          .set({ return_until: returnUntil, updated_at: now })
          .where("id", "=", existing.id)
          .where((eb) =>
            eb.or([eb("return_until", "is", null), eb("return_until", "!=", returnUntil)]),
          )
          .execute();
      }
      return existing.id;
    }
    return createOrder(trx, snapshot.order, now, {
      placedAt: snapshot.order.placedAt,
      returnUntil: snapshot.order.returnUntil ?? null,
      importedAt,
    });
  }

  async #writeRelated(
    trx: Trx,
    input: {
      parcelId: string;
      connectionId: string;
      connectionKind: ConnectionRow["kind"];
      role: "primary" | "handoff" | "mail";
      snapshot: ParcelSnapshot;
      now: string;
    },
  ): Promise<void> {
    const { parcelId, connectionId, connectionKind, role, snapshot, now } = input;
    await trx
      .insertInto("parcel_connections")
      .values({
        parcel_id: parcelId,
        connection_id: connectionId,
        external_ref: snapshot.externalRef,
        role,
        last_seen_at: now,
        missing_since: null,
      })
      .onConflict((oc) =>
        oc.columns(["parcel_id", "connection_id"]).doUpdateSet({
          external_ref: snapshot.externalRef,
          role,
          last_seen_at: now,
          missing_since: null,
        }),
      )
      .execute();
    for (const event of snapshot.history) {
      const position = coordinates(event);
      await trx
        .insertInto("parcel_events")
        .values({
          parcel_id: parcelId,
          connection_id: connectionId,
          at: event.at,
          status: event.status,
          raw_status: event.rawStatus,
          location_text: event.location,
          ...position,
          fingerprint: fingerprint(event),
        })
        .onConflict((oc) => {
          const target = oc.columns(["parcel_id", "fingerprint"]);
          // The carrier's own position wins over one looked up from the place name.
          return position.latitude === null
            ? target.doNothing()
            : target
                .doUpdateSet({ ...position, geocoded: 0 })
                .where((eb) =>
                  eb.or([
                    eb("parcel_events.geocoded", "=", 1),
                    eb("parcel_events.latitude", "is", null),
                  ]),
                );
        })
        .execute();
    }
    if (snapshot.historyComplete === true) {
      let stale = trx
        .deleteFrom("parcel_events")
        .where("parcel_id", "=", parcelId)
        .where("connection_id", "=", connectionId);
      const kept = snapshot.history.map((event) => fingerprint(event));
      if (kept.length > 0) {
        stale = stale.where("fingerprint", "not in", kept);
      }
      await stale.execute();
    }
    if (snapshot.items.length > 0 && (await this.#mayWriteItems(trx, parcelId, connectionKind))) {
      const next = snapshot.items.map((item, position) => ({
        parcel_id: parcelId,
        position,
        title: item.title,
        image_ref: item.imageUrl,
        url: item.url,
        external_id: item.externalId,
        quantity: item.quantity,
        price: item.price,
        currency: item.currency,
      }));
      const stored = await trx
        .selectFrom("items")
        .selectAll()
        .where("parcel_id", "=", parcelId)
        .orderBy("position")
        .execute();
      // Unchanged items are left alone: rewriting them would count as a change for delta sync.
      if (!sameRows(stored, next)) {
        await trx.deleteFrom("items").where("parcel_id", "=", parcelId).execute();
        await trx.insertInto("items").values(next).execute();
      }
    }
    if (snapshot.raw !== null) {
      // Codes that open something and personal data (names, addresses) never reach storage.
      const payload = JSON.stringify(scrubRaw(snapshot.raw));
      await trx
        .insertInto("parcel_raw")
        .values({ parcel_id: parcelId, connection_id: connectionId, fetched_at: now, payload })
        .onConflict((oc) =>
          oc.columns(["parcel_id", "connection_id"]).doUpdateSet({ fetched_at: now, payload }),
        )
        .execute();
    }
  }

  /**
   * Items have one writer, so two connections never take turns replacing each other's list: a shop
   * (who sold the items, with images and prices) always writes them; anyone else (a mail's plain
   * titles, a carrier) only fills a parcel that has none.
   */
  async #mayWriteItems(trx: Trx, parcelId: string, kind: ConnectionRow["kind"]): Promise<boolean> {
    if (kind === "shop") {
      return true;
    }
    const stored = await trx
      .selectFrom("items")
      .select("id")
      .where("parcel_id", "=", parcelId)
      .executeTakeFirst();
    return stored === undefined;
  }

  /** Marks the asked parcels found or not found; `since` moves only when the state changes. */
  async #recordLookup(
    trx: Trx,
    asked: readonly string[],
    seen: ReadonlySet<string>,
  ): Promise<number> {
    if (asked.length === 0) {
      return 0;
    }
    const now = isoNow(this.clock);
    const found = asked.filter((id) => seen.has(id));
    const missing = asked.filter((id) => !seen.has(id));
    for (const [ids, state] of [
      [found, "found"],
      [missing, "not_found"],
    ] as const) {
      if (ids.length === 0) {
        continue;
      }
      await trx
        .updateTable("parcels")
        .set((eb) => ({
          lookup_since: eb
            .case()
            .when("lookup_state", "=", state)
            .then(eb.ref("lookup_since"))
            .else(now)
            .end(),
          lookup_state: state,
          lookup_checked_at: now,
        }))
        .where("id", "in", ids)
        .execute();
    }
    return found.length;
  }

  async #markMissing(trx: Trx, connectionId: string, seen: ReadonlySet<string>): Promise<void> {
    let query = trx
      .updateTable("parcel_connections")
      .set({ missing_since: isoNow(this.clock) })
      .where("connection_id", "=", connectionId)
      .where("missing_since", "is", null);
    if (seen.size > 0) {
      query = query.where("parcel_id", "not in", [...seen]);
    }
    await query.execute();
  }

  /**
   * Fires `parcel.removed` for active parcels that every linked connection has stopped listing for
   * the grace period. While any linked connection is failing, nothing is judged for that parcel.
   */
  async judgeRemovals(): Promise<number> {
    const cutoff = addMs(this.clock.now(), -REMOVAL_GRACE_MS).toISOString();
    const candidates = await this.db
      .selectFrom("parcels")
      .select("parcels.id")
      .where("parcels.delivered", "=", 0)
      .where("parcels.removed_at", "is", null)
      .where("parcels.archived_at", "is", null)
      .where("parcels.manual_status", "is", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("parcel_connections")
            .select("parcel_connections.parcel_id")
            .whereRef("parcel_connections.parcel_id", "=", "parcels.id"),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("parcel_connections")
              .innerJoin("connections", "connections.id", "parcel_connections.connection_id")
              .select("parcel_connections.parcel_id")
              .whereRef("parcel_connections.parcel_id", "=", "parcels.id")
              .where((inner) =>
                inner.or([
                  inner("parcel_connections.missing_since", "is", null),
                  inner("parcel_connections.missing_since", ">", cutoff),
                  inner("connections.state", "!=", "ok"),
                  // A tracking link never judges a removal, even one marked by an older version.
                  inner("connections.kind", "=", "tracking"),
                ]),
              ),
          ),
        ),
      )
      .execute();
    if (candidates.length === 0) {
      return 0;
    }
    await this.db.transaction().execute(async (trx) => {
      const repository = new ParcelRepository(trx, this.presentation);
      for (const { id } of candidates) {
        await trx
          .updateTable("parcels")
          .set({ removed_at: isoNow(this.clock) })
          .where("id", "=", id)
          .execute();
        const parcel = await repository.get(id);
        if (parcel !== undefined) {
          await appendEvent(trx, this.clock, {
            type: "parcel.removed",
            parcelId: id,
            payload: parcelEventPayload(parcel),
          });
        }
      }
    });
    await this.bus.notify();
    return candidates.length;
  }
}
