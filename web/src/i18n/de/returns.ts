import type { Messages } from "../messages";

export const returns: Messages["returns"] = {
  title: "Rücksendungen",
  show: "Anzeigen",
  views: {
    open: {
      label: "Offen",
      empty:
        "Keine offenen Rücksendungen. Eine bei einem Shop begonnene Rücksendung erscheint hier, sobald ihr Konto oder eine Rücksende-E-Mail sie meldet.",
    },
    closed: {
      label: "Abgeschlossen",
      empty: "Keine erstatteten, abgelehnten, stornierten oder abgelaufenen Rücksendungen.",
    },
    all: { label: "Alle", empty: "Noch keine Rücksendungen." },
  },
  status: {
    requested: "Rücksendung angefragt",
    label_created: "Etikett bereit",
    dropped_off: "Abgegeben",
    in_transit: "Auf dem Rückweg",
    received: "Beim Shop eingegangen",
    refunded: "Erstattet",
    rejected: "Abgelehnt",
    cancelled: "Storniert",
    expired: "Frist abgelaufen",
  },
  kinds: {
    shop: "Shop",
    parcel_locker: "Paketautomat",
    post_office: "Postfiliale",
    pickup: "Abholung",
    any: "Beliebige Abgabestelle",
  },
  free: "Kostenlose Rücksendung",
  costsMoney: "Rücksendung kostenpflichtig",
  costs: (amount) => `Rücksendung kostet ${amount}`,
  refunded: (amount) => (amount === null ? "Erstattet" : `${amount} erstattet`),
  refundExpected: (amount) =>
    amount === null ? "Erstattung erwartet" : `Erstattung von ${amount} erwartet`,
  untitled: "Rücksendung",
  returnBy: "Zurücksenden bis",
  dropOff: "Abgabe",
  cost: "Kosten",
  refund: "Erstattung",
  reason: "Grund",
  tracking: "Sendungsnummer",
  label: "Etikett oder QR-Code",
};
