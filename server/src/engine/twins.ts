import type { ExpressionBuilder, Transaction } from "kysely";
import type { Logger } from "pino";
import type { Clock } from "../clock.js";
import type { Database, ConnectionRow, ParcelRow } from "../db/schema.js";
import type { Presentation } from "../parcels/repository.js";
import { snapshot, type ParcelSnapshot } from "../provider/snapshot.js";
import { foldParcel } from "./fold.js";

/**
 * Twins: one tracking number stored under a shop's name and under the carrier that delivers it.
 * The reconciler infers hand-offs from them and folds each pair into one parcel under the carrier.
 */

type Trx = Transaction<Database>;

/** What folding needs from the reconciler. */
export interface TwinEnv {
  readonly clock: Clock;
  readonly presentation: Presentation;
  readonly logger: Logger;
}

/**
 * Long enough to be a carrier's tracking code rather than a shop's own shipment key, so a shared
 * value across carriers means the same parcel.
 */
function isCarrierCode(trackingNumber: string): boolean {
  return /^[A-Z0-9]{8,40}$/i.test(trackingNumber);
}

/**
 * Parcels stored under a shop's name (a provider that has a shop connection) with this code, other than
 * `carrier`'s. Imported parcels count too, linked to the shop or not.
 */
async function shopTwins(
  trx: Trx,
  trackingNumber: string,
  carrier: string,
): Promise<{ carrier: string; tracking_number: string }[]> {
  return trx
    .selectFrom("parcels")
    .select(["parcels.carrier", "parcels.tracking_number"])
    .where("parcels.tracking_number", "=", trackingNumber)
    .where("parcels.carrier", "!=", carrier)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("connections")
          .select("connections.id")
          .where("connections.kind", "=", "shop")
          .whereRef("connections.provider", "=", "parcels.carrier"),
      ),
    )
    .execute();
}

/**
 * A hand-off goes to a carrier, never to another shop: a parcel stored under a provider that has a
 * shop connection is not a hand-off target, so a second shop's parcel with the same code is not
 * folded into it.
 */
function notUnderAShop(eb: ExpressionBuilder<Database, "parcels">) {
  return eb.not(
    eb.exists(
      eb
        .selectFrom("connections")
        .select("connections.id")
        .where("connections.kind", "=", "shop")
        .whereRef("connections.provider", "=", "parcels.carrier"),
    ),
  );
}

export async function findParcel(
  trx: Trx,
  carrier: string,
  trackingNumber: string,
): Promise<ParcelRow | undefined> {
  return trx
    .selectFrom("parcels")
    .selectAll()
    .where("carrier", "=", carrier)
    .where("tracking_number", "=", trackingNumber)
    .executeTakeFirst();
}

/**
 * A shop that reports a carrier's code without naming the carrier (an unmapped carrier code, a
 * page without tracking details) still hands the parcel off: when exactly one parcel of another
 * carrier has the same code, the shop's snapshot becomes a hand-off to it.
 */
export async function withInferredHandoff(
  trx: Trx,
  connection: ConnectionRow,
  snapshot: ParcelSnapshot,
): Promise<ParcelSnapshot> {
  if (
    snapshot.handoff !== null ||
    connection.kind !== "shop" ||
    !isCarrierCode(snapshot.trackingNumber)
  ) {
    return snapshot;
  }
  const twins = await trx
    .selectFrom("parcels")
    .select(["carrier", "tracking_number"])
    .where("tracking_number", "=", snapshot.trackingNumber)
    .where("carrier", "!=", snapshot.carrier)
    .where(notUnderAShop)
    .execute();
  const [twin] = twins;
  return twins.length === 1 && twin !== undefined
    ? { ...snapshot, handoff: { carrier: twin.carrier, trackingNumber: twin.tracking_number } }
    : snapshot;
}

/**
 * The reverse: a carrier reports a code that a shop already stored under its own name. The shop's
 * parcel is folded into the carrier's, so the code is one parcel with two connections.
 */
export async function adoptShopTwin(
  trx: Trx,
  env: TwinEnv,
  snapshot: ParcelSnapshot,
): Promise<void> {
  if (!isCarrierCode(snapshot.trackingNumber)) {
    return;
  }
  const twins = await shopTwins(trx, snapshot.trackingNumber, snapshot.carrier);
  const [twin] = twins;
  if (twins.length !== 1 || twin === undefined) {
    return;
  }
  const target = await findParcel(trx, snapshot.carrier, snapshot.trackingNumber);
  await foldShopDuplicate(
    trx,
    env,
    {
      ...snapshot,
      carrier: twin.carrier,
      trackingNumber: twin.tracking_number,
      handoff: { carrier: snapshot.carrier, trackingNumber: snapshot.trackingNumber },
    },
    target,
  );
}

/**
 * Repairs codes stored twice, once by a shop and once by the carrier that delivers it, from
 * before hand-offs were inferred. Each pair becomes one parcel under the carrier. Idempotent.
 */
export async function foldStoredTwins(trx: Trx, env: TwinEnv): Promise<number> {
  const shopProviders = await trx
    .selectFrom("connections")
    .select("provider")
    .where("kind", "=", "shop")
    .distinct()
    .execute();
  if (shopProviders.length === 0) {
    return 0;
  }
  const rows = await trx
    .selectFrom("parcels")
    .select(["carrier", "tracking_number"])
    .where(
      "carrier",
      "in",
      shopProviders.map((row) => row.provider),
    )
    .execute();
  let folded = 0;
  for (const shop of rows) {
    if (!isCarrierCode(shop.tracking_number)) {
      continue;
    }
    const others = await trx
      .selectFrom("parcels")
      .selectAll()
      .where("tracking_number", "=", shop.tracking_number)
      .where("carrier", "!=", shop.carrier)
      .where(notUnderAShop)
      .execute();
    const [target] = others;
    if (others.length !== 1 || target === undefined) {
      continue;
    }
    await foldShopDuplicate(
      trx,
      env,
      snapshot({
        carrier: shop.carrier,
        trackingNumber: shop.tracking_number,
        status: null,
        rawStatus: null,
        handoff: { carrier: target.carrier, trackingNumber: target.tracking_number },
      }),
      target,
    );
    folded += 1;
  }
  return folded;
}

/**
 * A shop may have reported a parcel under its own key before it knew the real carrier. Once the
 * hand-off is known, that entry is moved under the carrier's key, or folded into the carrier's
 * parcel if one exists, so there is never a duplicate.
 */
export async function foldShopDuplicate(
  trx: Trx,
  env: TwinEnv,
  snapshot: ParcelSnapshot,
  target: ParcelRow | undefined,
): Promise<ParcelRow | undefined> {
  const handoff = snapshot.handoff;
  if (handoff === null) {
    return target;
  }
  const duplicate = await findParcel(trx, snapshot.carrier, snapshot.trackingNumber);
  if (duplicate === undefined || duplicate.id === target?.id) {
    return target;
  }
  if (target === undefined) {
    await trx
      .updateTable("parcels")
      .set({ carrier: handoff.carrier, tracking_number: handoff.trackingNumber })
      .where("id", "=", duplicate.id)
      .execute();
    // The shop's links now hand the parcel off; the carrier's own connection becomes primary.
    await trx
      .updateTable("parcel_connections")
      .set({ role: "handoff" })
      .where("parcel_id", "=", duplicate.id)
      .where("role", "=", "primary")
      .execute();
    env.logger.debug({ parcelId: duplicate.id }, "Re-keyed a shop parcel under its carrier.");
    return { ...duplicate, carrier: handoff.carrier, tracking_number: handoff.trackingNumber };
  }
  // History, links, raw payloads and items move over; the duplicate goes, naming the target.
  await foldParcel(trx, env, duplicate, target, { linkRole: "handoff" });
  env.logger.debug({ parcelId: target.id }, "Folded a shop duplicate into the carrier parcel.");
  return target;
}
