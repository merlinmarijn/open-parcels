import { z } from "zod";
import { defineCarrier, type ParcelSnapshot, type SnapshotItem } from "../../provider/api.js";
import {
  DEMO_CARRIER,
  DEMO_PARCELS,
  DEMO_POLL_MS,
  DEMO_SHOP,
  DEMO_SHOP_NAME,
  GIFT_VOUCHER,
  runOf,
  type DemoParcel,
} from "../demo/data.js";

/**
 * Demo shop: the orders behind the demo courier's made-up parcels (see `../demo/data.ts`). It never
 * goes online except for the placeholder item pictures, fetched through the image proxy.
 */

const order = (parcel: DemoParcel, now: number): ParcelSnapshot["order"] => ({
  shop: DEMO_SHOP_NAME,
  orderNumber: parcel.order.number,
  placedAt: new Date(runOf(now).start - parcel.order.placedSecondsBefore * 1000).toISOString(),
});

/** The shop knows the order and its items and who carries it; the courier knows the rest. */
function fromShop(parcel: DemoParcel, now: number): ParcelSnapshot {
  return {
    carrier: DEMO_SHOP,
    trackingNumber: parcel.barcode,
    direction: "receiving",
    status: null,
    rawStatus: null,
    delivered: false,
    deliveredAt: null,
    expectedFrom: null,
    expectedTo: null,
    pickup: false,
    pickupPoint: null,
    url: null,
    sender: DEMO_SHOP_NAME,
    receiver: null,
    weightKg: null,
    history: [],
    // Drops what an earlier version of the demo shop stored as its own history.
    historyComplete: true,
    items: parcel.items,
    orderItems: orderLines(parcel.order.number),
    order: order(parcel, now),
    externalRef: null,
    handoff: { carrier: DEMO_CARRIER, trackingNumber: parcel.barcode },
    raw: { demo: true, barcode: parcel.barcode },
    live: null,
  };
}

/**
 * Everything in an order: the items of its parcels, plus for DEMO-1001 a gift voucher that the
 * shop lists in no parcel, so it belongs to the order only.
 */
function orderLines(orderNumber: string): SnapshotItem[] {
  const lines = DEMO_PARCELS.filter((parcel) => parcel.order.number === orderNumber).flatMap(
    (parcel) => parcel.items,
  );
  return orderNumber === "DEMO-1001" ? [...lines, GIFT_VOUCHER] : lines;
}

export const demoShop = defineCarrier({
  id: DEMO_SHOP,
  pollIntervalMs: DEMO_POLL_MS,
  configSchema: z.looseObject({}),
  secretSchema: z.null(),
  signIn: { type: "none" },
  http: { limits: { "*": { intervalMs: 1_000, burst: 1 } } },
  fetchAccount: (context) => {
    const now = context.clock.now().getTime();
    return Promise.resolve({
      snapshots: DEMO_PARCELS.map((parcel) => fromShop(parcel, now)),
      complete: true,
    });
  },
});
