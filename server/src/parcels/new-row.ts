import type { NewParcelRow } from "../db/schema.js";
import type { Direction } from "../domain/parcel.js";

interface NewParcel {
  readonly id: string;
  readonly carrier: string;
  readonly trackingNumber: string;
  readonly direction: Direction;
  /** First seen, last seen and updated. */
  readonly now: string;
}

type Columns = Omit<NewParcelRow, "id" | "carrier" | "tracking_number" | "direction">;

/**
 * The one row every writer inserts for a new parcel (the parcel service, the reconciler and both
 * imports): an unknown, undelivered parcel seen now, with the writer's own columns on top.
 */
export function newParcelRow(parcel: NewParcel, columns: Partial<Columns> = {}): NewParcelRow {
  return {
    id: parcel.id,
    carrier: parcel.carrier,
    tracking_number: parcel.trackingNumber,
    direction: parcel.direction,
    status: "unknown",
    raw_status: null,
    delivered: 0,
    pickup: 0,
    label: null,
    order_id: null,
    manual_status: null,
    first_seen_at: parcel.now,
    last_seen_at: parcel.now,
    updated_at: parcel.now,
    ...columns,
  };
}
