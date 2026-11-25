import type { ExpressionBuilder, Kysely } from "kysely";
import { DAY_MS, isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { appendEvent } from "../events/bus.js";
import { parcelEventPayload } from "../events/payload.js";
import { deleteParcels } from "../parcels/bulk-delete.js";
import { ParcelRepository, RAW_PRESENTATION, type Presentation } from "../parcels/repository.js";

export interface RetentionPolicy {
  /** Delivered parcels leave the default lists this many days after delivery. */
  readonly archiveAfterDays: number;
  /**
   * Archived parcels, with their history and items, are deleted this many days after archiving;
   * 0 keeps them forever (the default), and raw carrier payloads are then kept too.
   */
  readonly deleteAfterDays: number;
  /** Raw carrier payloads are dropped this many days after delivery. */
  readonly rawAfterDays: number;
  /**
   * Undelivered parcels the carrier has answered "not found" for this many days without a break
   * are archived (not deleted, and no `parcel.removed`). 0 turns it off. A manual status keeps
   * the parcel.
   */
  readonly notFoundArchiveDays: number;
}

export interface RetentionResult {
  readonly archived: number;
  readonly notFoundArchived: number;
  readonly deleted: number;
  readonly rawDropped: number;
}

/**
 * Delivered as every client sees it: a manual status wins over the carrier's (a parcel marked
 * delivered by hand counts, one the owner set back to "in transit" does not).
 */
function effectivelyDelivered(eb: ExpressionBuilder<Database, "parcels">) {
  return eb.or([
    eb.and([eb("manual_status", "is", null), eb("delivered", "=", 1)]),
    eb("manual_status", "=", "delivered"),
  ]);
}

/** Delivered before `iso`: by the carrier's delivery time, else when it was marked by hand. */
function deliveredBefore(iso: string) {
  return (eb: ExpressionBuilder<Database, "parcels">) =>
    eb.and([effectivelyDelivered(eb), eb(eb.fn.coalesce("delivered_at", "manual_at"), "<", iso)]);
}

/**
 * Archives the parcels in `ids`, firing `parcel.archived` for each, so clients that keep state
 * from events drop them from their active lists without a full reload.
 */
async function archive(
  trx: Kysely<Database>,
  clock: Clock,
  presentation: Presentation,
  ids: readonly string[],
): Promise<number> {
  const at = isoNow(clock);
  const repository = new ParcelRepository(trx, presentation);
  for (const id of ids) {
    await trx.updateTable("parcels").set({ archived_at: at }).where("id", "=", id).execute();
    const parcel = await repository.get(id);
    if (parcel !== undefined) {
      await appendEvent(trx, clock, {
        type: "parcel.archived",
        parcelId: id,
        payload: parcelEventPayload({ ...parcel, history: [] }),
      });
    }
  }
  return ids.length;
}

/**
 * Applies the retention policy to the parcels' effective delivered state and time. Every parcel it
 * archives fires `parcel.archived` and every one it deletes `parcel.deleted`, in one transaction;
 * the caller notifies the event bus.
 */
export async function applyRetention(
  db: Kysely<Database>,
  clock: Clock,
  policy: RetentionPolicy,
  presentation: Presentation = RAW_PRESENTATION,
): Promise<RetentionResult> {
  const now = clock.now().getTime();
  const iso = (daysAgo: number): string => new Date(now - daysAgo * DAY_MS).toISOString();
  return db.transaction().execute(async (trx) => {
    const delivered = await trx
      .selectFrom("parcels")
      .select("id")
      .where("archived_at", "is", null)
      .where(deliveredBefore(iso(policy.archiveAfterDays)))
      .execute();
    const archived = await archive(
      trx,
      clock,
      presentation,
      delivered.map((row) => row.id),
    );
    const lost =
      policy.notFoundArchiveDays <= 0
        ? []
        : await trx
            .selectFrom("parcels")
            .select("id")
            .where("delivered", "=", 0)
            .where("archived_at", "is", null)
            .where("manual_status", "is", null)
            .where("lookup_state", "=", "not_found")
            .where("lookup_since", "<", iso(policy.notFoundArchiveDays))
            .execute();
    const notFoundArchived = await archive(
      trx,
      clock,
      presentation,
      lost.map((row) => row.id),
    );
    // Deleting is the owner's choice: with deleteAfterDays 0 nothing is ever deleted on its own.
    if (policy.deleteAfterDays === 0) {
      return { archived, notFoundArchived, deleted: 0, rawDropped: 0 };
    }
    const expired = await trx
      .selectFrom("parcels")
      .select("id")
      .where("archived_at", "<", iso(policy.deleteAfterDays))
      .execute();
    const deleted = await deleteParcels(
      trx,
      clock,
      presentation,
      expired.map((row) => row.id),
    );
    const rawDropped = await trx
      .deleteFrom("parcel_raw")
      .where("parcel_id", "in", (eb) =>
        eb
          .selectFrom("parcels")
          .select("id")
          .where(deliveredBefore(iso(policy.rawAfterDays))),
      )
      .executeTakeFirst();
    return {
      archived,
      notFoundArchived,
      deleted,
      rawDropped: Number(rawDropped.numDeletedRows),
    };
  });
}
