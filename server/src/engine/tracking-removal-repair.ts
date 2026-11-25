import type { Kysely } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { linkedToKind } from "../db/visibility.js";
import { appendParcelEvents } from "./repair-events.js";

/**
 * Undoes removals that older versions derived from tracking lookups. Tracking connections used to
 * claim complete answers, so a code the carrier did not know yet was marked missing and, six hours
 * later, removed. A parcel is revived only when that path is provable: every link it has is to a
 * tracking connection, and at least one of them carries such a missing mark. Every tracking link's
 * mark is cleared too, since a lookup never sets one now. Each revived parcel fires
 * `parcel.registered`, since clients dropped it on `parcel.removed`. Idempotent; returns the
 * parcels revived.
 */
export async function reviveTrackingRemovals(db: Kysely<Database>, clock: Clock): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const revivable = await trx
      .selectFrom("parcels")
      .select("parcels.id")
      .where("parcels.removed_at", "is not", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("parcel_connections")
            .innerJoin("connections", "connections.id", "parcel_connections.connection_id")
            .select("parcel_connections.parcel_id")
            .whereRef("parcel_connections.parcel_id", "=", "parcels.id")
            .where("connections.kind", "=", "tracking")
            .where("parcel_connections.missing_since", "is not", null),
        ),
      )
      .where((eb) => eb.not(linkedToKind(eb, ["account", "shop", "mail"])))
      .execute();
    if (revivable.length > 0) {
      await trx
        .updateTable("parcels")
        .set({ removed_at: null, updated_at: isoNow(clock) })
        .where(
          "id",
          "in",
          revivable.map((row) => row.id),
        )
        .execute();
      await appendParcelEvents(
        trx,
        clock,
        "parcel.registered",
        revivable.map((row) => row.id),
      );
    }
    await trx
      .updateTable("parcel_connections")
      .set({ missing_since: null })
      .where("missing_since", "is not", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("connections")
            .select("connections.id")
            .whereRef("connections.id", "=", "parcel_connections.connection_id")
            .where("connections.kind", "=", "tracking"),
        ),
      )
      .execute();
    return revivable.length;
  });
}
