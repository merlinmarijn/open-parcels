import { z } from "zod";

/**
 * A return: something the owner sends back to a shop. It belongs to an order, may name the
 * order's items, and once the shop or carrier gives a tracking number it is tracked like any
 * parcel (an outgoing one).
 */
export const RETURN_STATUSES = [
  "requested",
  "label_created",
  "dropped_off",
  "in_transit",
  "received",
  "refunded",
  "rejected",
  "cancelled",
  "expired",
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/** Where a return may be handed in. `any`: any shop or point of the carrier. */
export const DROP_OFF_KINDS = ["shop", "parcel_locker", "post_office", "pickup", "any"] as const;
export type DropOffKind = (typeof DROP_OFF_KINDS)[number];

export const REFUND_STATUSES = ["pending", "issued"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export interface DropOffOption {
  /** Carrier id from the rules, or null when the option names none. */
  readonly carrier: string | null;
  readonly kind: DropOffKind;
  /** The shop's own words, e.g. "DHL drop-off, no printer needed". */
  readonly description: string | null;
}

/**
 * How far a status is along. A report never moves a return back (mails arrive out of order); a
 * closing status (rejected, cancelled) always applies. `expired` is never stored: it is read off
 * the return-by date (`presentedStatus`).
 */
const RANK: Readonly<Record<ReturnStatus, number>> = {
  requested: 0,
  label_created: 1,
  dropped_off: 2,
  in_transit: 3,
  received: 4,
  refunded: 5,
  expired: 0,
  rejected: 6,
  cancelled: 6,
};

/** The stored status after a connection reported `next`. */
export function nextReturnStatus(
  current: ReturnStatus | null,
  next: ReturnStatus | null,
): ReturnStatus {
  if (next === null || next === "expired") return current ?? "requested";
  if (current === null) return next;
  return RANK[next] >= RANK[current] ? next : current;
}

/** Still waiting for the owner to hand it in. */
export function awaitingDropOff(status: ReturnStatus): boolean {
  return status === "requested" || status === "label_created";
}

/**
 * The status shown: a return not handed in by its return-by day (`YYYY-MM-DD`, in the server's
 * zone) reads `expired`. `today` is the server's local day.
 */
export function presentedStatus(
  status: ReturnStatus,
  returnBy: string | null,
  today: string,
): ReturnStatus {
  return awaitingDropOff(status) && returnBy !== null && returnBy < today ? "expired" : status;
}

export function asReturnStatus(value: string | null): ReturnStatus | null {
  return value !== null && RETURN_STATUSES.includes(value as ReturnStatus)
    ? (value as ReturnStatus)
    : null;
}

const httpUrl = z
  .string()
  .refine((value) => /^https?:\/\//i.test(value), "Only http(s) addresses.")
  .describe("An http(s) address.");

export const dropOffOptionSchema = z.object({
  carrier: z.string().nullable(),
  kind: z.enum(DROP_OFF_KINDS),
  description: z.string().nullable(),
});

export const returnSchema = z.object({
  id: z.uuid(),
  order_id: z.uuid(),
  shop: z.string(),
  order_number: z.string(),
  status: z.enum(RETURN_STATUSES),
  reason: z.string().nullable(),
  return_by: z.iso.date().nullable().describe("The last local day to hand the return in."),
  drop_off: z.array(dropOffOptionSchema),
  cost: z
    .object({
      free: z.boolean(),
      amount: z.number().nullable(),
      currency: z.string().nullable(),
    })
    .nullable()
    .describe("What sending it back costs; null when not known."),
  label_url: httpUrl.nullable(),
  carrier: z.string().nullable(),
  tracking_number: z.string().nullable(),
  /** The outgoing parcel that tracks the return, once its tracking number is known. */
  parcel_id: z.uuid().nullable(),
  refund: z
    .object({
      amount: z.number().nullable(),
      currency: z.string().nullable(),
      status: z.enum(REFUND_STATUSES),
    })
    .nullable(),
  items: z.array(z.object({ title: z.string(), order_item_position: z.number().int().nullable() })),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Return = z.infer<typeof returnSchema>;

const KIND_LABELS: Readonly<Record<DropOffKind, string>> = {
  shop: "Shop",
  parcel_locker: "Parcel locker",
  post_office: "Post office",
  pickup: "Pickup",
  any: "Any drop-off point",
};

/** One drop-off option in words: the shop's description, else its kind and carrier. */
export function dropOffText(option: DropOffOption): string {
  const kind = KIND_LABELS[option.kind];
  const carrier = option.carrier === null ? "" : ` (${option.carrier})`;
  return option.description ?? `${kind}${carrier}`;
}

/** The cost in words, or null when it is not known. */
export function costText(cost: Return["cost"]): string | null {
  if (cost === null) return null;
  if (cost.free) return "Free return";
  if (cost.amount === null) return "Return costs money";
  return `Return costs ${cost.amount.toFixed(2)}${cost.currency === null ? "" : ` ${cost.currency}`}`;
}

/** What a calendar entry says about a return: where to hand it in and what it costs. */
export function returnDetails(entry: Pick<Return, "drop_off" | "cost">): string[] {
  const lines = entry.drop_off.map((option) => `Drop off: ${dropOffText(option)}`);
  const cost = costText(entry.cost);
  return cost === null ? lines : [...lines, cost];
}
