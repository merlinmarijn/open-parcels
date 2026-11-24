import type { Kysely } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { Database, ParcelUpdate } from "../db/schema.js";
import { type Direction, type Parcel, type ParcelStatus } from "../domain/parcel.js";
import { normaliseTrackingNumber } from "../engine/tracking-number.js";
import { applyRetention, type RetentionPolicy, type RetentionResult } from "../engine/retention.js";
import { deriveEvents, type EventView } from "../engine/rules.js";
import { removeOrphanedAutoConnections } from "../engine/connections.js";
import { appendEvent, type EventBus } from "../events/bus.js";
import { parcelEventPayload } from "../events/payload.js";
import {
  clearConnectionData,
  countConnectionData,
  type ConnectionDataCounts,
} from "./clear-connection.js";
import { DataCleaner } from "./data-cleaner.js";
import { ParcelRepository, RAW_PRESENTATION, type Presentation } from "./repository.js";

export class DuplicateParcelError extends Error {
  override readonly name = "DuplicateParcelError";

  constructor(readonly existingId: string) {
    super("This parcel is already tracked.");
  }
}

export interface NewParcelInput {
  readonly carrier: string;
  readonly trackingNumber: string;
  readonly direction: Direction;
  readonly label: string | null;
}

export interface ParcelPatch {
  readonly label?: string | null;
  readonly manualStatus?: ParcelStatus | null;
  readonly archived?: boolean;
}

/**
 * Called after a code was added by hand, so the carrier's tracking connection picks it up. Returns the
 * connection id it was linked to, or undefined when no installed provider can track this carrier.
 */
export type TrackingLinker = (carrier: string) => Promise<string | undefined>;

/** Parcels as read through the repository already carry the effective status and flag. */
function view(parcel: Parcel): EventView {
  return {
    direction: parcel.direction,
    status: parcel.status,
    delivered: parcel.delivered,
    expectedFrom: parcel.expected_from,
    expectedTo: parcel.expected_to,
  };
}

/** User-initiated parcel changes. Carrier updates go through the reconciler instead. */
export class ParcelService {
  readonly repository: ParcelRepository;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly linkTracking: TrackingLinker,
    private readonly presentation: Presentation = RAW_PRESENTATION,
  ) {
    this.repository = new ParcelRepository(db, presentation);
  }

  async create(given: NewParcelInput): Promise<Parcel> {
    // Stored in the carrier's own spelling, the one its answers come back in.
    const input = {
      ...given,
      trackingNumber: normaliseTrackingNumber(given.carrier, given.trackingNumber),
    };
    // Checked first so a duplicate never links a tracking connection, and again inside the write.
    const known = await this.repository.findIdByTrackingNumber(input.carrier, input.trackingNumber);
    if (known !== undefined) {
      throw new DuplicateParcelError(known);
    }
    const connectionId = await this.linkTracking(input.carrier);
    const id = crypto.randomUUID();
    const now = isoNow(this.clock);
    await this.db.transaction().execute(async (trx) => {
      // Checked inside the transaction, so two adds of one code can never both pass the check.
      const existing = await new ParcelRepository(trx, this.presentation).findIdByTrackingNumber(
        input.carrier,
        input.trackingNumber,
      );
      if (existing !== undefined) {
        throw new DuplicateParcelError(existing);
      }
      await trx
        .insertInto("parcels")
        .values({
          id,
          carrier: input.carrier,
          tracking_number: input.trackingNumber,
          direction: input.direction,
          status: "registered",
          raw_status: null,
          delivered: 0,
          pickup: 0,
          label: input.label,
          first_seen_at: now,
          last_seen_at: now,
          updated_at: now,
        })
        .execute();
      if (connectionId !== undefined) {
        await trx
          .insertInto("parcel_connections")
          .values({
            parcel_id: id,
            connection_id: connectionId,
            external_ref: null,
            role: "primary",
            last_seen_at: now,
          })
          .execute();
      }
      const parcel = await new ParcelRepository(trx, this.presentation).get(id);
      if (parcel === undefined) {
        throw new Error("Inserted parcel could not be read back.");
      }
      for (const event of deriveEvents(null, view(parcel))) {
        await appendEvent(trx, this.clock, {
          type: event.type,
          parcelId: id,
          payload: parcelEventPayload(parcel, event.changes),
        });
      }
    });
    await this.bus.notify();
    return this.#mustGet(id);
  }

  /** Applies a user edit. Returns undefined when the parcel does not exist. */
  async update(id: string, patch: ParcelPatch): Promise<Parcel | undefined> {
    const before = await this.repository.get(id);
    if (before === undefined) {
      return undefined;
    }
    const now = isoNow(this.clock);
    const changes: ParcelUpdate = { updated_at: now };
    if (patch.label !== undefined) {
      changes.label = patch.label;
    }
    if (patch.manualStatus !== undefined && patch.manualStatus !== before.manual_status) {
      changes.manual_status = patch.manualStatus;
      changes.manual_at = patch.manualStatus === null ? null : now;
    }
    if (patch.archived !== undefined) {
      changes.archived_at = patch.archived ? now : null;
    }
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable("parcels").set(changes).where("id", "=", id).execute();
      const after = await new ParcelRepository(trx, this.presentation).get(id);
      if (after === undefined) {
        return;
      }
      for (const event of deriveEvents(view(before), view(after))) {
        await appendEvent(trx, this.clock, {
          type: event.type,
          parcelId: id,
          payload: parcelEventPayload(after, event.changes),
        });
      }
      if (before.archived_at === null && after.archived_at !== null) {
        await appendEvent(trx, this.clock, {
          type: "parcel.archived",
          parcelId: id,
          payload: parcelEventPayload({ ...after, history: [] }),
        });
      }
    });
    await this.bus.notify();
    return this.#mustGet(id);
  }

  /** Applies the retention policy (see `applyRetention`) and delivers its events. */
  async applyRetention(policy: RetentionPolicy): Promise<RetentionResult> {
    const result = await applyRetention(this.db, this.clock, policy, this.presentation);
    if (Object.values(result).some((count) => count > 0)) {
      await this.bus.notify();
    }
    return result;
  }

  /**
   * Deletes the parcel and fires `parcel.deleted`, so clients drop it at once. A tracking connection
   * the app created for it alone goes too, with `connection.removed`.
   */
  async delete(id: string): Promise<boolean> {
    const deleted = await this.db.transaction().execute(async (trx) => {
      const parcel = await new ParcelRepository(trx, this.presentation).get(id);
      if (parcel === undefined) {
        return false;
      }
      await trx.deleteFrom("parcels").where("id", "=", id).execute();
      await appendEvent(trx, this.clock, {
        type: "parcel.deleted",
        parcelId: id,
        payload: parcelEventPayload({ ...parcel, history: [] }),
      });
      await removeOrphanedAutoConnections(
        trx,
        this.clock,
        parcel.connections.map((connection) => connection.connection_id),
      );
      return true;
    });
    if (deleted) {
      await this.bus.notify();
    }
    return deleted;
  }

  /** The owner's clean-up actions for the Data page. */
  cleaner(): DataCleaner {
    return new DataCleaner({
      db: this.db,
      bus: this.bus,
      clock: this.clock,
      presentation: this.presentation,
    });
  }

  /** What clearing this connection would remove. */
  countConnectionData(connectionId: string): Promise<ConnectionDataCounts> {
    return countConnectionData(this.db, connectionId);
  }

  /** Removes everything this connection imported; see `clearConnectionData`. */
  async clearConnectionData(connectionId: string): Promise<ConnectionDataCounts> {
    const counts = await clearConnectionData(
      { db: this.db, clock: this.clock, presentation: this.presentation },
      connectionId,
    );
    await this.bus.notify();
    return counts;
  }

  async #mustGet(id: string): Promise<Parcel> {
    const parcel = await this.repository.get(id);
    if (parcel === undefined) {
      throw new Error("Parcel disappeared while being written.");
    }
    return parcel;
  }
}
