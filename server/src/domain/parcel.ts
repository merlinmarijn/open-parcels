import { z } from "zod";

/**
 * The canonical status list shared with the Home Assistant parcel suite. Every carrier maps its
 * own vocabulary onto exactly these values, so automations can target `out_for_delivery`
 * regardless of the carrier. Do not extend or rename.
 */
const PARCEL_STATUSES = [
  "registered",
  "in_transit",
  "out_for_delivery",
  "at_pickup_point",
  "delivered",
  "returning",
  "problem",
  "unknown",
] as const;
export type ParcelStatus = (typeof PARCEL_STATUSES)[number];
export const parcelStatusSchema = z.enum(PARCEL_STATUSES);

/** A stored status, or null when the column is empty or holds a value this version does not know. */
export function parseStatus(value: string | null): ParcelStatus | null {
  return value !== null && PARCEL_STATUSES.includes(value as ParcelStatus)
    ? (value as ParcelStatus)
    : null;
}

/** A stored status, with "unknown" for an empty or unknown value. */
export function statusOrUnknown(value: string | null): ParcelStatus {
  return parseStatus(value) ?? "unknown";
}

export const DIRECTIONS = ["receiving", "sending"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** States of a courier map session (parcel-live/1). */
const LIVE_STATES = ["en_route", "next_stop", "delivered", "ended"] as const;
export type LiveState = (typeof LIVE_STATES)[number];

const LOCATION_SOURCES = ["courier", "event"] as const;
const LOCATION_PRECISIONS = ["exact", "street", "area"] as const;

const isoDateTime = z.iso.datetime({ offset: true });
const localDate = z.iso.date();

export const historyEntrySchema = z.object({
  timestamp: isoDateTime,
  status: parcelStatusSchema.nullable(),
  raw_status: z.string(),
  location: z.string().nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  /**
   * True when the coordinates were looked up from `location` (the place's centre) instead of
   * coming from the carrier; false otherwise, also when there are none.
   */
  approximate: z.boolean(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/** parcel-items/1: what is in the parcel. Images are served through the image proxy. */
const itemSchema = z.object({
  title: z.string(),
  image_url: z.string().nullable(),
  url: z.string().nullable(),
  quantity: z.number().int().positive().nullable(),
  price: z.number().nullable(),
  currency: z.string().nullable(),
});
export type Item = z.infer<typeof itemSchema>;

/** An order line: `parcel_id` is the parcel carrying it, null while that is not known. */
export const orderItemSchema = itemSchema.extend({ parcel_id: z.uuid().nullable() });
export type OrderItem = z.infer<typeof orderItemSchema>;

/** How a parcel without its own label is named (the "Default parcel label" setting). */
export const PARCEL_LABEL_MODES = ["tracking_number", "items"] as const;
export type ParcelLabelMode = (typeof PARCEL_LABEL_MODES)[number];

/**
 * parcel-live/1: the courier on the last mile. Coordinates are the courier's, never the
 * destination's, shown while the courier is on the road (the last stops included) and null once
 * the session has ended.
 */
const liveSchema = z.object({
  state: z.enum(LIVE_STATES),
  stops_away: z.number().int().nonnegative().nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  accuracy: z.number().nonnegative().nullable(),
  position_at: isoDateTime.nullable(),
  message: z.string().nullable(),
  updated_at: isoDateTime,
});
export type Live = z.infer<typeof liveSchema>;

/** parcel-location/1: where the parcel is, as far as anything can tell. */
export const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  source: z.enum(LOCATION_SOURCES),
  precision: z.enum(LOCATION_PRECISIONS),
  name: z.string().nullable(),
  address: z.string().nullable(),
  at: isoDateTime.nullable(),
});

/** Every connection kind: the providers' and the inbox. */
export const connectionKindSchema = z.enum(["account", "tracking", "shop", "mail"]);

const parcelConnectionRefSchema = z.object({
  connection_id: z.string(),
  provider: z.string(),
  label: z.string(),
  kind: connectionKindSchema,
  role: z.enum(["primary", "handoff", "mail"]),
  last_seen_at: isoDateTime,
});

const LOOKUP_STATES = ["pending", "found", "not_found"] as const;

/**
 * What the carrier said the last time a tracking connection asked about the code. `pending`: never
 * answered (or not followed by any tracking connection); `not_found`: the carrier was asked and did
 * not return the code. `since` is when the state began, `checked_at` the last time it was asked.
 */
const lookupSchema = z.object({
  state: z.enum(LOOKUP_STATES),
  since: isoDateTime.nullable(),
  checked_at: isoDateTime.nullable(),
});

/**
 * The normalised parcel every client sees. The first block mirrors the Home Assistant suite's
 * contract key for key; the rest are this service's additions. Keys are never omitted: unknown
 * values are null.
 *
 * `status` and `delivered` are the effective values: a manual status wins (§2.5). What the carrier
 * itself last said stays available as `carrier_status` and `carrier_delivered`.
 */
export const parcelSchema = z.object({
  carrier: z.string(),
  tracking_number: z.string(),
  sender: z.string().nullable(),
  receiver: z.string().nullable(),
  status: parcelStatusSchema,
  raw_status: z.string().nullable(),
  delivered: z.boolean(),
  delivered_at: isoDateTime.nullable(),
  expected_from: isoDateTime.nullable(),
  expected_to: isoDateTime.nullable(),
  /**
   * The expected delivery as local days (`YYYY-MM-DD` in the server's time zone) when it is whole
   * days, so clients need not guess from the times in their own zone; null when it has times.
   */
  expected_days: z.object({ from: localDate, to: localDate }).nullable(),
  pickup: z.boolean(),
  pickup_point: z.string().nullable(),
  history: z.array(historyEntrySchema),
  url: z.string().nullable(),

  id: z.uuid(),
  direction: z.enum(DIRECTIONS),
  label: z.string().nullable(),
  /** The label, else (per the "Default parcel label" setting) the item names or the code. */
  display_name: z.string(),
  manual_status: parcelStatusSchema.nullable(),
  carrier_status: parcelStatusSchema,
  carrier_delivered: z.boolean(),
  archived_at: isoDateTime.nullable(),
  items: z.array(itemSchema),
  live: liveSchema.nullable(),
  /** Where the parcel is now: the live courier while one is shown, else `last_scan`. */
  location: locationSchema.nullable(),
  /** The newest scan that came with coordinates, also while a courier is shown. */
  last_scan: locationSchema.nullable(),
  /** The order the parcel belongs to; `id` addresses it under /api/v1/orders. */
  order: z
    .object({
      shop: z.string(),
      order_number: z.string(),
      items: z.array(orderItemSchema),
      id: z.uuid(),
    })
    .nullable(),
  connections: z.array(parcelConnectionRefSchema),
  lookup: lookupSchema,
  first_seen_at: isoDateTime,
  updated_at: isoDateTime,
});
export type Parcel = z.infer<typeof parcelSchema>;

/** A parcel counts as active until it is delivered; a manual status always wins. */
export function effectiveStatus(parcel: {
  readonly status: ParcelStatus;
  readonly manual_status: ParcelStatus | null;
}): ParcelStatus {
  return parcel.manual_status ?? parcel.status;
}

/** Delivered as far as anyone should care: a manual status wins over the carrier's flag. */
export function effectiveDelivered(
  carrierDelivered: boolean,
  manualStatus: ParcelStatus | null,
): boolean {
  return manualStatus === null ? carrierDelivered : manualStatus === "delivered";
}
