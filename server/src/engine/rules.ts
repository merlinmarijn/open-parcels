import type { Direction, ParcelStatus } from "../domain/parcel.js";
import type { EventType } from "../events/types.js";

/** What the event rules compare. `status` is the effective status: a manual override wins. */
export interface EventView {
  readonly direction: Direction;
  readonly status: ParcelStatus;
  readonly delivered: boolean;
  readonly expectedFrom: string | null;
  readonly expectedTo: string | null;
}

export interface DerivedEvent {
  readonly type: EventType;
  readonly changes: Readonly<Record<string, unknown>>;
}

/**
 * The canonical event rules:
 * - a new, undelivered parcel fires `registered` (or `sending_registered`); a parcel first seen
 *   already delivered is history and fires nothing, so an account's first sync never floods
 *   notifications;
 * - the hop to delivered fires only `delivered` (or `sending_delivered`), never also
 *   `status_changed`;
 * - other status changes fire `status_changed`;
 * - a changed delivery window on an undelivered parcel fires `delivery_time_changed`.
 */
export function deriveEvents(before: EventView | null, after: EventView): DerivedEvent[] {
  if (before === null) {
    if (after.delivered || after.status === "delivered") {
      return [];
    }
    return [
      {
        type: after.direction === "sending" ? "parcel.sending_registered" : "parcel.registered",
        changes: {},
      },
    ];
  }
  const events: DerivedEvent[] = [];
  if (before.status !== after.status) {
    const changes = { old_status: before.status, new_status: after.status };
    if (after.status === "delivered") {
      events.push({
        type: after.direction === "sending" ? "parcel.sending_delivered" : "parcel.delivered",
        changes,
      });
    } else {
      events.push({ type: "parcel.status_changed", changes });
    }
  }
  const windowChanged =
    before.expectedFrom !== after.expectedFrom || before.expectedTo !== after.expectedTo;
  if (windowChanged && !after.delivered && after.status !== "delivered") {
    events.push({
      type: "parcel.delivery_time_changed",
      changes: {
        old_expected_from: before.expectedFrom,
        old_expected_to: before.expectedTo,
        new_expected_from: after.expectedFrom,
        new_expected_to: after.expectedTo,
      },
    });
  }
  return events;
}
