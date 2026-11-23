import type { Kysely } from "kysely";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { removeOrphanedAutoSources } from "../engine/sources.js";
import { appendEvent } from "../events/bus.js";
import { parcelEventPayload } from "../events/payload.js";
import { ParcelRepository, type Presentation } from "./repository.js";

/**
 * Deletes these parcels with their history, items and links inside the caller's transaction,
 * firing `parcel.deleted` for each, and removes keyless tracking sources left without parcels.
 * Returns how many were deleted.
 */
export async function deleteParcels(
  trx: Kysely<Database>,
  clock: Clock,
  presentation: Presentation,
  ids: readonly string[],
  keepSource?: string,
): Promise<number> {
  const repository = new ParcelRepository(trx, presentation);
  const linked = new Set<string>();
  let deleted = 0;
  for (const id of ids) {
    const parcel = await repository.get(id);
    if (parcel === undefined) continue;
    for (const link of parcel.sources) linked.add(link.source_id);
    await trx.deleteFrom("parcels").where("id", "=", id).execute();
    await appendEvent(trx, clock, {
      type: "parcel.deleted",
      parcelId: id,
      payload: parcelEventPayload({ ...parcel, history: [] }),
    });
    deleted += 1;
  }
  if (keepSource !== undefined) linked.delete(keepSource);
  await removeOrphanedAutoSources(trx, clock, [...linked]);
  return deleted;
}

/**
 * Deletes these orders outright (no tombstone, so a source may list them again) with their
 * items, firing `order.deleted` for each. Their parcels stay, without an order.
 */
export async function deleteOrders(
  trx: Kysely<Database>,
  clock: Clock,
  ids: readonly string[],
): Promise<number> {
  for (const id of ids) {
    const parcels = await trx
      .selectFrom("parcels")
      .select("id")
      .where("order_id", "=", id)
      .execute();
    await trx.deleteFrom("orders").where("id", "=", id).execute();
    await appendEvent(trx, clock, {
      type: "order.deleted",
      parcelId: null,
      payload: { id, parcel_ids: parcels.map((row) => row.id) },
    });
  }
  return ids.length;
}
