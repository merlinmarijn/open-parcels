import type { Kysely } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { isPlausibleOrder, shopFromDomain } from "../domain/order.js";
import { appendEvent } from "../events/bus.js";

/**
 * Removes the misfiled order `id`, firing `order.deleted` with `merged_into`. With a twin
 * (`into`), its parcels, item lines (numbered after the twin's own) and source links move there
 * first; without one its parcels lose the order and its item lines are deleted with it.
 */
async function mergeOrderInto(
  trx: Kysely<Database>,
  clock: Clock,
  id: string,
  into: string | null,
): Promise<void> {
  const now = isoNow(clock);
  const parcels = await trx.selectFrom("parcels").select("id").where("order_id", "=", id).execute();
  await trx
    .updateTable("parcels")
    .set({ order_id: into, updated_at: now })
    .where("order_id", "=", id)
    .execute();
  if (into !== null) {
    const last = await trx
      .selectFrom("order_items")
      .select((eb) => eb.fn.max("position").as("position"))
      .where("order_id", "=", into)
      .executeTakeFirst();
    const offset = (last?.position ?? -1) + 1;
    await trx
      .updateTable("order_items")
      .set((eb) => ({ order_id: into, position: eb("position", "+", offset) }))
      .where("order_id", "=", id)
      .execute();
    await trx
      .insertInto("order_sources")
      .columns(["order_id", "source_id"])
      .expression((eb) =>
        eb
          .selectFrom("order_sources")
          .select([eb.val(into).as("order_id"), "source_id"])
          .where("order_id", "=", id),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
    await trx.updateTable("orders").set({ updated_at: now }).where("id", "=", into).execute();
  }
  await trx.deleteFrom("orders").where("id", "=", id).execute();
  await appendEvent(trx, clock, {
    type: "order.deleted",
    parcelId: null,
    payload: { id, parcel_ids: parcels.map((row) => row.id), merged_into: into },
  });
}

/**
 * Moves orders whose number cannot belong to their shop (an Amazon order without an Amazon order
 * number) to the shop their parcels are named after, else to `unknown`. Only numbers that are
 * provably not the shop's are touched. When the corrected order already exists, the parcels, item
 * lines and source links move to it (see `mergeOrderInto`). Idempotent; returns how many orders
 * were corrected.
 */
export async function repairOrderShops(db: Kysely<Database>, clock: Clock): Promise<number> {
  return db.transaction().execute(async (trx) => {
    // A deleted order is a tombstone: never repaired, never a twin to move parcels onto.
    const orders = await trx
      .selectFrom("orders")
      .select(["id", "shop", "order_number"])
      .where("deleted_at", "is", null)
      .execute();
    let repaired = 0;
    for (const order of orders) {
      if (isPlausibleOrder(order.shop, order.order_number)) {
        continue;
      }
      const labels = await trx
        .selectFrom("parcels")
        .select("label")
        .where("order_id", "=", order.id)
        .execute();
      const named = new Set(
        labels.map((row) => shopFromDomain(row.label)).filter((shop) => shop !== null),
      );
      const [only] = named;
      const shop = named.size === 1 && only !== undefined ? only : "unknown";
      const twin = await trx
        .selectFrom("orders")
        .select(["id", "deleted_at"])
        .where("shop", "=", shop)
        .where("order_number", "=", order.order_number)
        .executeTakeFirst();
      if (twin === undefined) {
        await trx
          .updateTable("orders")
          .set({ shop, updated_at: isoNow(clock) })
          .where("id", "=", order.id)
          .execute();
      } else {
        // A deleted twin means the user deleted this very order: like that deletion, its item
        // lines go and its parcels stay without an order. A live twin takes everything over.
        const into = twin.deleted_at === null ? twin.id : null;
        await mergeOrderInto(trx, clock, order.id, into);
      }
      repaired += 1;
    }
    return repaired;
  });
}
