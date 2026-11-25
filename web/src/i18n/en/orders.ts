import { plural } from "../plural";

/** English texts: orders. The German file must have the same keys (the type enforces it). */
export const orders = {
  title: "Orders",
  show: "Show",
  status: {
    ordered: "Ordered",
    partly_shipped: "Partly shipped",
    shipped: "Shipped",
    partly_delivered: "Partly delivered",
    delivered: "Delivered",
    problem: "Problem",
    cancelled: "Cancelled",
    refunded: "Refunded",
  },
  views: {
    open: {
      label: "Open",
      help: "Orders still on their way: at least one parcel has not arrived yet.",
      empty:
        "No open orders. Orders found through a shop connection or an order email show up here.",
    },
    delivered: {
      label: "Delivered",
      help:
        "Every parcel has arrived. Delivered parcels are archived after the retention period, " +
        "and an order moves to Archived once all its parcels are archived.",
      empty: "No delivered orders that are not archived yet.",
    },
    archived: {
      label: "Archived",
      help:
        "Orders whose parcels are all archived, orders that never got a parcel 30 days after " +
        "they were placed, and orders you archived yourself. Open one to bring it back.",
      empty: "Nothing archived yet.",
    },
    all: {
      label: "All",
      help: "Every order, open, delivered and archived.",
      empty: "No orders yet.",
    },
  },
  totalFrom: (amount: string) => `from ${amount}`,
  placed: (when: string) => `Placed ${when}`,
  itemCount: (count: number) => `${String(count)} ${plural(count, "item", "items")}`,
  digitalNoParcel: "Digital order, no parcel",
  noParcel: "No parcel",
  noTrackedParcel: "No tracked parcel",
  noParcelYet: "No parcel known yet",
  deliveredOf: (delivered: number, total: number) =>
    `${String(delivered)} of ${String(total)} ${plural(total, "parcel", "parcels")} delivered`,
  deliveredParcels: "Delivered parcels",
  items: "Items",
  archive: {
    archived: "You archived this order. It stays archived until you restore it.",
    kept: "You restored this order, so it stays out of the archive even once all its parcels are archived.",
    endedArchived: (status: "cancelled" | "refunded") =>
      `Archived automatically: the order was ${status}.`,
    endedPending: (status: "cancelled" | "refunded") => `Archived automatically once ${status}.`,
    parcelsArchived: "Archived automatically: all its parcels are archived.",
    parcelsPending:
      "Archived automatically once all its parcels are archived. Delivered parcels are archived after the retention period.",
    archivedAt: (when: string) => ` Archived ${when}.`,
  },
  unarchive: "Unarchive",
  archiveAction: "Archive",
  archiveAutomatically: "Archive automatically",
  archiveAutomaticallyHint: "Let the order follow its parcels again",
  delete: "Delete",
  deleteQuestion:
    "Delete this order? Its parcels stay tracked, without the order. A shop that " +
    "lists the order again will not bring it back.",
  itemsMissing: "The shop did not list the items.",
  itemParcelUnknown: "Parcel not known yet",
  itemIn: (parcel: string) => `In ${parcel}`,
  returns: "Returns",
  returnWindow: (day: string) => `Return window: until ${day}.`,
  allOrders: "All orders",
  parcels: "Parcels",
  sentence: (text: string) => `${text}.`,
};
