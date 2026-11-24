/** A return as the order page and the Returns list show it. */
import { Link } from "@tanstack/react-router";
import { Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import type { ParcelStatus, Return, ReturnStatus } from "../api/types";

export const RETURN_STATUS_LABELS: Readonly<Record<ReturnStatus, string>> = {
  requested: "Return requested",
  label_created: "Label ready",
  dropped_off: "Handed in",
  in_transit: "On its way back",
  received: "Received by the shop",
  refunded: "Refunded",
  rejected: "Rejected",
  cancelled: "Cancelled",
  expired: "Deadline passed",
};

/** The parcel status whose colour a return status borrows. */
const STATUS_COLOUR: Readonly<Record<ReturnStatus, ParcelStatus>> = {
  requested: "registered",
  label_created: "registered",
  dropped_off: "in_transit",
  in_transit: "in_transit",
  received: "out_for_delivery",
  refunded: "delivered",
  rejected: "problem",
  cancelled: "unknown",
  expired: "problem",
};

const KIND_LABELS: Readonly<Record<Return["drop_off"][number]["kind"], string>> = {
  shop: "Shop",
  parcel_locker: "Parcel locker",
  post_office: "Post office",
  pickup: "Pickup",
  any: "Any drop-off point",
};

/** A `YYYY-MM-DD` day in words, read as that local day (never shifted by the time zone). */
export function formatDay(day: string): string {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(year, month - 1, date));
}

export function formatMoney(amount: number, currency: string | null): string {
  if (currency === null) return amount.toFixed(2);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** "Free return", "Return costs 4,99 €", or null when not known. */
export function costLabel(cost: Return["cost"]): string | null {
  if (cost === null) return null;
  if (cost.free) return "Free return";
  return cost.amount === null
    ? "Return costs money"
    : `Return costs ${formatMoney(cost.amount, cost.currency)}`;
}

export function refundLabel(refund: Return["refund"]): string | null {
  if (refund === null) return null;
  const amount = refund.amount === null ? "" : ` ${formatMoney(refund.amount, refund.currency)}`;
  return refund.status === "issued" ? `Refunded${amount}` : `Refund expected${amount}`;
}

export function dropOffLabel(option: Return["drop_off"][number]): string {
  return (
    option.description ??
    `${KIND_LABELS[option.kind]}${option.carrier === null ? "" : ` (${option.carrier})`}`
  );
}

export function ReturnStatusBadge({ status }: { readonly status: ReturnStatus }): ReactNode {
  return (
    <span className={`badge status-${STATUS_COLOUR[status]}`}>{RETURN_STATUS_LABELS[status]}</span>
  );
}

/** One return: status, deadline, where to hand it in, cost, refund, label and its parcel. */
export function ReturnCard({
  entry,
  showOrder = false,
}: {
  readonly entry: Return;
  readonly showOrder?: boolean;
}): ReactNode {
  const titleId = `return-${entry.id}`;
  const cost = costLabel(entry.cost);
  const refund = refundLabel(entry.refund);
  const title = entry.items.map((item) => item.title).join(", ");
  return (
    <section className="glass-panel return-card" aria-labelledby={titleId}>
      <div className="order-head">
        <Undo2 size={20} className="page-icon" aria-hidden="true" />
        <div className="order-head-text">
          <h3 id={titleId}>{title === "" ? "Return" : title}</h3>
          {showOrder ? (
            <Link to="/orders/$orderId" params={{ orderId: entry.order_id }} className="mono muted">
              {entry.shop} {entry.order_number}
            </Link>
          ) : null}
        </div>
        <ReturnStatusBadge status={entry.status} />
      </div>
      <dl className="return-facts">
        {entry.return_by === null ? null : (
          <>
            <dt>Return by</dt>
            <dd>{formatDay(entry.return_by)}</dd>
          </>
        )}
        {entry.drop_off.length === 0 ? null : (
          <>
            <dt>Drop off</dt>
            <dd>
              <ul className="return-drop-off">
                {entry.drop_off.map((option) => (
                  <li key={dropOffLabel(option)}>{dropOffLabel(option)}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {cost === null ? null : (
          <>
            <dt>Cost</dt>
            <dd>{cost}</dd>
          </>
        )}
        {refund === null ? null : (
          <>
            <dt>Refund</dt>
            <dd>{refund}</dd>
          </>
        )}
        {entry.reason === null ? null : (
          <>
            <dt>Reason</dt>
            <dd>{entry.reason}</dd>
          </>
        )}
        {entry.tracking_number === null ? null : (
          <>
            <dt>Tracking</dt>
            <dd>
              {entry.parcel_id === null ? (
                <span className="mono">{entry.tracking_number}</span>
              ) : (
                <Link to="/parcels/$parcelId" params={{ parcelId: entry.parcel_id }}>
                  <span className="mono">{entry.tracking_number}</span>
                </Link>
              )}
            </dd>
          </>
        )}
      </dl>
      {entry.label_url === null ? null : (
        <a
          href={entry.label_url}
          target="_blank"
          rel="noreferrer noopener"
          className="button small"
        >
          Label or QR code
        </a>
      )}
    </section>
  );
}
