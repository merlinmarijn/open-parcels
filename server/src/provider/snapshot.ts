import type { Direction, ParcelStatus } from "../domain/parcel.js";
import type { DropOffOption, RefundStatus, ReturnStatus } from "../domain/return.js";
import type { LiveTarget } from "./live.js";

/** One history entry as the carrier reports it. `status` is null when the raw value did not map. */
export interface SnapshotEvent {
  readonly at: string;
  readonly status: ParcelStatus | null;
  readonly rawStatus: string;
  readonly location: string | null;
  /** Where the scan happened, when the carrier gives coordinates (WGS 84). */
  readonly latitude?: number;
  readonly longitude?: number;
  /**
   * The source's own identity for this entry (a mail's Message-ID), when it has one. The stored
   * entry is then deduplicated on it instead of on time and text, so one mail is one entry.
   */
  readonly id?: string;
}

export interface SnapshotItem {
  readonly title: string;
  /** Remote image URL; the server serves it through its image proxy, never directly. */
  readonly imageUrl: string | null;
  readonly url: string | null;
  readonly externalId: string | null;
  readonly quantity: number | null;
  readonly price: number | null;
  readonly currency: string | null;
}

/**
 * What a source knows about one parcel at one moment. Plug-ins return these; only the reconciler
 * turns them into stored parcels and events. Unknown values are null, never guessed.
 */
export interface ParcelSnapshot {
  /** Carrier id of the company physically carrying the parcel (`dhl`, `amazon`, …). */
  readonly carrier: string;
  readonly barcode: string;
  readonly direction: Direction;
  /** Mapped status, or null when the carrier's latest value is unknown to us. */
  readonly status: ParcelStatus | null;
  readonly rawStatus: string | null;
  readonly delivered: boolean;
  readonly deliveredAt: string | null;
  readonly plannedFrom: string | null;
  readonly plannedTo: string | null;
  readonly pickup: boolean;
  readonly pickupPoint: string | null;
  readonly url: string | null;
  readonly sender: string | null;
  readonly receiver: string | null;
  readonly weightKg: number | null;
  readonly history: readonly SnapshotEvent[];
  /**
   * The history is everything this source has for the parcel: entries it stored earlier and no
   * longer reports are dropped (only its own, never another source's). For sources whose history
   * starts over, like the demo plug-ins' loop.
   */
  readonly historyComplete?: boolean;
  /** Items known to be in this parcel. */
  readonly items: readonly SnapshotItem[];
  /**
   * Everything in the order, when the source knows the order but not (for every item) which
   * parcel carries it, like a shop. Items also listed in `items` are linked to this parcel; the
   * rest belong to the order only. Unset: the order's items are left as they are.
   */
  readonly orderItems?: readonly SnapshotItem[];
  readonly order: {
    readonly shop: string;
    readonly orderNumber: string;
    readonly placedAt: string | null;
    /** Last day of the shop's return window (`YYYY-MM-DD`), when it lists one. */
    readonly returnUntil?: string | null;
  } | null;
  /** The source's own reference for this parcel (order line, shipment id), if different from the barcode. */
  readonly externalRef: string | null;
  /**
   * Set by shops when another carrier delivers the parcel. The reconciler then files this snapshot
   * under that carrier's parcel, so the shop and the carrier never produce two entries.
   */
  readonly handoff: { readonly carrier: string; readonly barcode: string } | null;
  /** The raw payload, stored separately. Must not contain codes that open or sign in to anything. */
  readonly raw: unknown;
  /** Set when the carrier can show the courier on a map for this parcel. Kept in memory only. */
  readonly live: LiveTarget | null;
}

/**
 * What a source knows about one return of an order. Unknown values are null and never erase what
 * another report said; `dropOff` replaces the stored options only when it lists some.
 */
export interface ReturnSnapshot {
  readonly order: { readonly shop: string; readonly orderNumber: string };
  /**
   * The shop's own id for the return, when it gives one. Without it the report updates the
   * order's newest open return, or starts one.
   */
  readonly externalRef: string | null;
  /** Null: the report says something about the return, but not where it stands. */
  readonly status: ReturnStatus | null;
  readonly reason: string | null;
  /** The last local day to hand it in, `YYYY-MM-DD`. */
  readonly returnBy: string | null;
  readonly dropOff: readonly DropOffOption[];
  readonly cost: {
    readonly free: boolean;
    readonly amount: number | null;
    readonly currency: string | null;
  } | null;
  /** Label or QR-code page; only http(s) is kept. */
  readonly labelUrl: string | null;
  /** The return's own parcel, when the shop or carrier gives its tracking number. */
  readonly tracking: { readonly carrier: string; readonly barcode: string } | null;
  readonly refund: {
    readonly amount: number | null;
    readonly currency: string | null;
    readonly status: RefundStatus;
  } | null;
  /** Item titles, matched to the order's lines where they agree. */
  readonly items: readonly string[];
  /**
   * Whether this report may start a return when the order has none open. A refund alone (which
   * can be for a cancelled order) only updates a return already known.
   */
  readonly mayCreate: boolean;
}

/** Fills the optional parts of a return report, so sources only spell out what they know. */
export function returnSnapshot(
  required: Pick<ReturnSnapshot, "order" | "status"> & Partial<ReturnSnapshot>,
): ReturnSnapshot {
  return {
    externalRef: null,
    reason: null,
    returnBy: null,
    dropOff: [],
    cost: null,
    labelUrl: null,
    tracking: null,
    refund: null,
    items: [],
    mayCreate: true,
    ...required,
  };
}

/** Fills the optional parts of a snapshot with nulls, so plug-ins only spell out what they know. */
export function snapshot(
  required: Pick<ParcelSnapshot, "carrier" | "barcode" | "status" | "rawStatus"> &
    Partial<ParcelSnapshot>,
): ParcelSnapshot {
  return {
    direction: "incoming",
    delivered: required.status === "delivered",
    deliveredAt: null,
    plannedFrom: null,
    plannedTo: null,
    pickup: false,
    pickupPoint: null,
    url: null,
    sender: null,
    receiver: null,
    weightKg: null,
    history: [],
    items: [],
    order: null,
    externalRef: null,
    handoff: null,
    raw: null,
    live: null,
    ...required,
  };
}
