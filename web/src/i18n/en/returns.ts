/** English texts: returns. The German file must have the same keys (the type enforces it). */
export const returns = {
  title: "Returns",
  show: "Show",
  views: {
    open: {
      label: "Open",
      empty:
        "No open returns. A return you start at a shop shows up here once its account or a return email reports it.",
    },
    closed: { label: "Closed", empty: "No refunded, rejected, cancelled or expired returns." },
    all: { label: "All", empty: "No returns yet." },
  },
  status: {
    requested: "Return requested",
    label_created: "Label ready",
    dropped_off: "Handed in",
    in_transit: "On its way back",
    received: "Received by the shop",
    refunded: "Refunded",
    rejected: "Rejected",
    cancelled: "Cancelled",
    expired: "Deadline passed",
  },
  kinds: {
    shop: "Shop",
    parcel_locker: "Parcel locker",
    post_office: "Post office",
    pickup: "Pickup",
    any: "Any drop-off point",
  },
  free: "Free return",
  costsMoney: "Return costs money",
  costs: (amount: string) => `Return costs ${amount}`,
  refunded: (amount: string | null) => (amount === null ? "Refunded" : `Refunded ${amount}`),
  refundExpected: (amount: string | null) =>
    amount === null ? "Refund expected" : `Refund expected ${amount}`,
  untitled: "Return",
  returnBy: "Return by",
  dropOff: "Drop off",
  cost: "Cost",
  refund: "Refund",
  reason: "Reason",
  tracking: "Tracking",
  label: "Label or QR code",
};
