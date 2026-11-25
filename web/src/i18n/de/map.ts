import { plural } from "../plural";
import type { Messages } from "../messages";

export const map: Messages["map"] = {
  title: "Live-Karte",
  summary: (pins, couriers) =>
    `${String(pins)} ${plural(pins, "Paket", "Pakete")} mit Ort, ${String(couriers)} ${plural(couriers, "Zusteller", "Zusteller")} live`,
  parcelsOnMap: "Pakete auf der Karte",
  home: "Zuhause",
  lastCarrierEvent: "Letztes Ereignis des Paketdiensts",
  stopsAway: (stops) => `, noch ${String(stops)} ${plural(stops, "Stopp", "Stopps")}`,
  approximateTown: "Ungefähr: Das Ereignis nannte nur den Ort",
  inTransit: "Pakete unterwegs",
  noneInTransit: "Keine aktiven Pakete unterwegs.",
  mapStyle: "Kartenstil",
  fallbackLayer: "Karte",
  fallbackAttribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende | <a href="https://www.openstreetmap.org/fixthemap">Kartenfehler melden</a>',
  openMap: "Karte öffnen",
  away: (distance) => `${distance} entfernt`,
  unavailable: "Karte nicht verfügbar",
  unavailableHint:
    "Dieses Paket hat noch keinen Ort auf der Karte. Seine Ereignisse erscheinen weiterhin im Verlauf.",
  parcelRoute: "Weg des Pakets",
  approximatePlace: "Ungefährer Ort",
  courier: "Zusteller",
};
