import { plural } from "../plural";
import type { Messages } from "../messages";

const ENDED = { cancelled: "storniert", refunded: "erstattet" } as const;

export const orders: Messages["orders"] = {
  title: "Bestellungen",
  show: "Anzeigen",
  status: {
    ordered: "Bestellt",
    partly_shipped: "Teilweise versandt",
    shipped: "Versandt",
    partly_delivered: "Teilweise zugestellt",
    delivered: "Zugestellt",
    problem: "Problem",
    cancelled: "Storniert",
    refunded: "Erstattet",
  },
  views: {
    open: {
      label: "Offen",
      help: "Bestellungen, die noch unterwegs sind: Mindestens ein Paket ist noch nicht angekommen.",
      empty:
        "Keine offenen Bestellungen. Bestellungen aus einer Shop-Verbindung oder einer Bestell-E-Mail erscheinen hier.",
    },
    delivered: {
      label: "Zugestellt",
      help:
        "Alle Pakete sind angekommen. Zugestellte Pakete werden nach der Aufbewahrungsfrist " +
        "archiviert, und eine Bestellung wandert ins Archiv, sobald alle ihre Pakete archiviert sind.",
      empty: "Keine zugestellten Bestellungen, die noch nicht archiviert sind.",
    },
    archived: {
      label: "Archiviert",
      help:
        "Bestellungen, deren Pakete alle archiviert sind, Bestellungen ohne Paket 30 Tage nach " +
        "der Bestellung und selbst archivierte Bestellungen. Zum Wiederherstellen eine öffnen.",
      empty: "Noch nichts archiviert.",
    },
    all: {
      label: "Alle",
      help: "Alle Bestellungen: offen, zugestellt und archiviert.",
      empty: "Noch keine Bestellungen.",
    },
  },
  totalFrom: (amount) => `ab ${amount}`,
  placed: (when) => `Bestellt ${when}`,
  itemCount: (count) => `${String(count)} Artikel`,
  digitalNoParcel: "Digitale Bestellung, kein Paket",
  noParcel: "Kein Paket",
  noTrackedParcel: "Kein verfolgtes Paket",
  noParcelYet: "Noch kein Paket bekannt",
  deliveredOf: (delivered, total) =>
    `${String(delivered)} von ${String(total)} ${plural(total, "Paket", "Paketen")} zugestellt`,
  deliveredParcels: "Zugestellte Pakete",
  items: "Artikel",
  parcelDelivered: (when) => `Zugestellt ${when}`,
  parcelExpected: (when) => `Voraussichtlich ${when}`,
  archive: {
    archived:
      "Diese Bestellung wurde von Hand archiviert. Sie bleibt im Archiv, bis sie wiederhergestellt wird.",
    kept: "Diese Bestellung wurde wiederhergestellt und bleibt außerhalb des Archivs, auch wenn alle ihre Pakete archiviert sind.",
    endedArchived: (status) => `Automatisch archiviert: Die Bestellung wurde ${ENDED[status]}.`,
    endedPending: (status) => `Wird automatisch archiviert, sobald ${ENDED[status]}.`,
    parcelsArchived: "Automatisch archiviert: Alle ihre Pakete sind archiviert.",
    parcelsPending:
      "Wird automatisch archiviert, sobald alle ihre Pakete archiviert sind. Zugestellte Pakete werden nach der Aufbewahrungsfrist archiviert.",
    archivedAt: (when) => ` Archiviert ${when}.`,
  },
  unarchive: "Wiederherstellen",
  archiveAction: "Archivieren",
  archiveAutomatically: "Automatisch archivieren",
  archiveAutomaticallyHint: "Die Bestellung wieder ihren Paketen folgen lassen",
  delete: "Löschen",
  deleteQuestion:
    "Diese Bestellung löschen? Ihre Pakete werden weiter verfolgt, ohne die Bestellung. Ein Shop, " +
    "der die Bestellung erneut auflistet, bringt sie nicht zurück.",
  itemsMissing: "Der Shop hat die Artikel nicht aufgeführt.",
  itemParcelUnknown: "Paket noch nicht bekannt",
  itemIn: (parcel) => `In ${parcel}`,
  returns: "Rücksendungen",
  returnWindow: (day) => `Rückgabefrist: bis ${day}.`,
  allOrders: "Alle Bestellungen",
  parcels: "Pakete",
  sentence: (text) => `${text}.`,
};
