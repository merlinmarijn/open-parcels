import { plural } from "../plural";

/** English texts: map. The German file must have the same keys (the type enforces it). */
export const map = {
  title: "Live map",
  summary: (pins: number, couriers: number) =>
    `${String(pins)} ${plural(pins, "parcel", "parcels")} with a place, ${String(couriers)} live ${plural(couriers, "courier", "couriers")}`,
  parcelsOnMap: "Parcels on the map",
  home: "Home",
  lastCarrierEvent: "Last carrier event",
  stopsAway: (stops: number) => `, ${String(stops)} ${plural(stops, "stop", "stops")} away`,
  approximateTown: "Approximate: the event named only the town",
  inTransit: "Parcels in transit",
  noneInTransit: "No active parcels in transit.",
  mapStyle: "Map style",
  fallbackLayer: "Map",
  openMap: "Open map",
  away: (distance: string) => `${distance} away`,
  unavailable: "Location map not available",
  unavailableHint:
    "This parcel has no place on the map yet. Its updates still appear in the history.",
  parcelRoute: "Parcel route",
  approximatePlace: "Approximate place",
  courier: "Courier",
};
