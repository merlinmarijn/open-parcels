import type { Transaction } from "kysely";
import type { Database } from "../db/schema.js";
import type { ParcelSnapshot, SnapshotItem } from "../provider/snapshot.js";

/** Matches an order line across polls: the shop's own id, else its title. */
function itemKey(item: { readonly externalId: string | null; readonly title: string }): string {
  return item.externalId ?? `title:${item.title}`;
}

/** Whether stored rows hold exactly `next`, field by field and in order (ids aside). */
export function sameRows(
  stored: readonly Readonly<Record<string, unknown>>[],
  next: readonly Readonly<Record<string, unknown>>[],
): boolean {
  return (
    stored.length === next.length &&
    next.every((row, index) =>
      Object.entries(row).every(([key, value]) => stored[index]?.[key] === value),
    )
  );
}

/**
 * Keeps the order's item list. With `orderItems` the list is replaced by the connection's, keeping
 * links to parcels that other snapshots made; items this snapshot lists for its parcel are linked
 * to it. Without, the parcel's items are added to (or linked in) the order's list.
 */
export async function writeOrderItems(
  trx: Transaction<Database>,
  orderId: string,
  parcelId: string,
  snapshot: ParcelSnapshot,
): Promise<void> {
  const inParcel = new Set(snapshot.items.map(itemKey));
  const stored = await trx
    .selectFrom("order_items")
    .selectAll()
    .where("order_id", "=", orderId)
    .orderBy("position")
    .execute();
  const linked = new Map(
    stored.map((row) => [
      itemKey({ externalId: row.external_id, title: row.title }),
      row.parcel_id,
    ]),
  );
  const row = (item: SnapshotItem, position: number) => ({
    order_id: orderId,
    position,
    title: item.title,
    image_ref: item.imageUrl,
    url: item.url,
    external_id: item.externalId,
    quantity: item.quantity,
    price: item.price,
    currency: item.currency,
    parcel_id: inParcel.has(itemKey(item)) ? parcelId : (linked.get(itemKey(item)) ?? null),
  });
  if (snapshot.orderItems !== undefined) {
    const next = snapshot.orderItems.map(row);
    // Unchanged lists are left alone: rewriting them would count as a change for delta sync.
    if (sameRows(stored, next)) return;
    await trx.deleteFrom("order_items").where("order_id", "=", orderId).execute();
    if (snapshot.orderItems.length > 0) {
      await trx.insertInto("order_items").values(next).execute();
    }
    return;
  }
  let position = stored.length;
  for (const item of snapshot.items) {
    const key = itemKey(item);
    const existing = stored.find(
      (candidate) => itemKey({ externalId: candidate.external_id, title: candidate.title }) === key,
    );
    if (existing === undefined) {
      await trx.insertInto("order_items").values(row(item, position)).execute();
      position += 1;
    } else if (existing.parcel_id === null) {
      await trx
        .updateTable("order_items")
        .set({ parcel_id: parcelId })
        .where("id", "=", existing.id)
        .execute();
    }
  }
}
