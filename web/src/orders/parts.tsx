/** Pieces shared by the orders list and an order's page. */
import type { ReactNode } from "react";
import type { Order, OrderStatus, OrderView, ParcelStatus } from "../api/types";
import { formatMoney, formatRelative } from "../lib/format";
import { t } from "../i18n";
import "./orders.css";
import { ArchivedBadge } from "../parcels/badges";
import { ParcelCard } from "../parcels/ParcelCard";

/** The parcel status whose colour an order status borrows. */
const STATUS_COLOUR: Readonly<Record<OrderStatus, ParcelStatus>> = {
  ordered: "registered",
  partly_shipped: "in_transit",
  shipped: "in_transit",
  partly_delivered: "out_for_delivery",
  delivered: "delivered",
  problem: "problem",
  cancelled: "unknown",
  refunded: "unknown",
};

/** The list's tabs, with what each one holds; "all" is reachable from the page (OP-153). */
export const ORDER_VIEW_TABS: readonly {
  readonly view: OrderView;
  readonly label: string;
  readonly help: string;
}[] = (["open", "delivered", "archived", "all"] as const).map((view) => ({
  view,
  label: t.orders.views[view].label,
  help: t.orders.views[view].help,
}));

function OrderStatusBadge({ status }: { readonly status: OrderStatus }): ReactNode {
  return <span className={`badge status-${STATUS_COLOUR[status]}`}>{t.orders.status[status]}</span>;
}

export function OrderBadges({ order }: { readonly order: Order }): ReactNode {
  return (
    <span className="order-badges">
      <OrderStatusBadge status={order.status} />
      {order.archived ? <ArchivedBadge /> : null}
    </span>
  );
}

export function formatTotal(total: Order["total"]): string | null {
  if (total === null) return null;
  const amount = formatMoney(total.amount, total.currency);
  // Some lines have no price: the order cost at least this much.
  return total.partial ? t.orders.totalFrom(amount) : amount;
}

/** "Placed 3 days ago · 2 items · 39,90 €" */
export function orderSummary(order: Order): string {
  const total = formatTotal(order.total);
  const count = order.items.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
  return [
    order.placed_at === null ? null : t.orders.placed(formatRelative(order.placed_at)),
    count === 0 ? null : t.orders.itemCount(count),
    total,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

export function OrderProgress({ order }: { readonly order: Order }): ReactNode {
  if (order.parcel_count === 0) {
    return (
      <div className="eta-label">
        {order.digital ? t.orders.digitalNoParcel : noParcelText(order.status)}
      </div>
    );
  }
  return (
    <div>
      <div className="eta-label">
        {t.orders.deliveredOf(order.delivered_count, order.parcel_count)}
      </div>
      <div
        className="order-progress"
        role="progressbar"
        aria-label={t.orders.deliveredParcels}
        aria-valuemin={0}
        aria-valuemax={order.parcel_count}
        aria-valuenow={order.delivered_count}
      >
        <span style={{ width: `${(order.delivered_count / order.parcel_count) * 100}%` }} />
      </div>
    </div>
  );
}

/** The order's parcels, each linking to its page, with status and where it is. */
export function OrderParcels({ order }: { readonly order: Order }): ReactNode {
  if (order.parcels.length === 0) return null;
  return (
    <ul className="parcel-list">
      {order.parcels.map((parcel) => (
        <li key={parcel.id}>
          <ParcelCard parcel={parcel} compact />
        </li>
      ))}
    </ul>
  );
}

/** What an order without parcels says where the parcels would be. */
export function noParcelText(status: OrderStatus): string {
  switch (status) {
    case "cancelled":
    case "refunded":
      return t.orders.noParcel;
    case "shipped":
    case "delivered":
      return t.orders.noTrackedParcel;
    case "ordered":
    case "partly_shipped":
    case "partly_delivered":
    case "problem":
      return t.orders.noParcelYet;
  }
}
