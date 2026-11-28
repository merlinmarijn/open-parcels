import type { Transaction } from "kysely";
import type { Database, ParcelRow } from "../db/schema.js";
import { foldParcel } from "./fold.js";
import type { TwinEnv } from "./twins.js";

type Trx = Transaction<Database>;

/** A parcel's items as one comparable value; undefined when it has none. */
async function itemSets(trx: Trx, ids: readonly string[]): Promise<Map<string, string>> {
  const rows = await trx
    .selectFrom("items")
    .select(["parcel_id", "title"])
    .where("parcel_id", "in", ids)
    .execute();
  const titles = new Map<string, string[]>();
  for (const row of rows) {
    titles.set(row.parcel_id, [...(titles.get(row.parcel_id) ?? []), row.title]);
  }
  return new Map([...titles].map(([id, list]) => [id, list.sort().join("\n")]));
}

/**
 * A shop renames a shipment as it moves: an order line before it ships, the shop's shipment id,
 * then the carrier's code. Each name stored a parcel of its own. After a shop run, a parcel this
 * connection listed before but not now is folded into the one parcel it did list for the same
 * order with the same items: the same shipment under its new name.
 * ponytail: two shipments of one order with identical items, one of them skipped this run, would
 * be folded together; needs a shipment id stable across names from the shop to rule out.
 */
export async function foldSuperseded(
  trx: Trx,
  env: TwinEnv,
  connectionId: string,
  seen: ReadonlySet<string>,
): Promise<number> {
  if (seen.size === 0) {
    return 0;
  }
  const fresh = await trx
    .selectFrom("parcels")
    .selectAll()
    .where("id", "in", [...seen])
    .where("order_id", "is not", null)
    .execute();
  const orders = [...new Set(fresh.map((row) => row.order_id))].filter((id) => id !== null);
  if (orders.length === 0) {
    return 0;
  }
  const stale: ParcelRow[] = await trx
    .selectFrom("parcels")
    .innerJoin("parcel_connections", "parcel_connections.parcel_id", "parcels.id")
    .selectAll("parcels")
    .where("parcel_connections.connection_id", "=", connectionId)
    .where("parcels.id", "not in", [...seen])
    .where("parcels.order_id", "in", orders)
    .execute();
  if (stale.length === 0) {
    return 0;
  }
  const items = await itemSets(
    trx,
    [...fresh, ...stale].map((row) => row.id),
  );
  let folded = 0;
  for (const old of stale) {
    const key = items.get(old.id);
    const matches = fresh.filter(
      (row) => key !== undefined && row.order_id === old.order_id && items.get(row.id) === key,
    );
    const [target] = matches;
    if (matches.length !== 1 || target === undefined) {
      continue;
    }
    await foldParcel(trx, env, old, target);
    env.logger.debug({ parcelId: target.id, from: old.id }, "Folded a renamed shop shipment.");
    folded += 1;
  }
  return folded;
}
