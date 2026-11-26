import { z } from "zod";
import { defineCarrier, type ParcelSnapshot } from "../../provider/api.js";
import {
  courierView,
  DEMO_CARRIER,
  DEMO_PARCELS,
  DEMO_POLL_MS,
  demoLiveReading,
  type DemoParcel,
} from "./data.js";

/**
 * Demo courier: made-up parcels for trying and testing open-parcels, replaying a ten minute story
 * from announced to delivered (see data.ts); the demo shop (`../demo_shop/`) holds their orders.
 * It never goes online except for the placeholder item pictures, fetched through the image proxy.
 */

const configSchema = z.looseObject({});
const secretSchema = z.null();

function fromCourier(parcel: DemoParcel, now: number): ParcelSnapshot {
  return {
    ...courierView(parcel, now),
    carrier: DEMO_CARRIER,
    // A courier knows neither the order nor what is inside; the shop does.
    items: [],
    order: null,
    handoff: null,
    raw: { demo: true, barcode: parcel.barcode },
  };
}

const LIMITS = { "*": { intervalMs: 1_000, burst: 1 } } as const;
const liveRef = z.object({ barcode: z.string() });

export const demoCarrier = defineCarrier({
  id: DEMO_CARRIER,
  pollIntervalMs: DEMO_POLL_MS,
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: { limits: LIMITS },
  fetchAccount: (context) => {
    const now = context.clock.now().getTime();
    return Promise.resolve({
      snapshots: DEMO_PARCELS.map((parcel) => fromCourier(parcel, now)),
      complete: true,
    });
  },
  track: (context, barcodes) => {
    const now = context.clock.now().getTime();
    const wanted = new Set(barcodes.map((code) => code.toUpperCase()));
    return Promise.resolve({
      snapshots: DEMO_PARCELS.filter((parcel) => wanted.has(parcel.barcode)).map((parcel) =>
        fromCourier(parcel, now),
      ),
      complete: true,
    });
  },
  readLive: (context, target) => {
    const ref = liveRef.safeParse(target.ref);
    return Promise.resolve(
      ref.success ? demoLiveReading(ref.data.barcode, context.clock.now().getTime()) : null,
    );
  },
});
