import ical, { ICalCalendarMethod } from "ical-generator";
import { findCarrier, loadRules } from "open-parcels-rules";
import type { CalendarEntry } from "./service.js";

/** A `YYYY-MM-DD` day as a UTC-midnight Date: what an all-day DTSTART/DTEND needs. */
function utcDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function summaryOf(entry: CalendarEntry, title: string): string {
  switch (entry.kind) {
    case "delivered":
      return `Delivered: ${title}`;
    case "return_by":
      return `Return by ${entry.startDate ?? entry.start.slice(0, 10)}: ${entry.title}`;
    case "expected":
      return title;
  }
}

export interface IcsOptions {
  readonly timeZone: string;
  readonly name: string;
  readonly publicUrl: URL | undefined;
}

/** Renders entries as an iCalendar feed. Event UIDs are stable per parcel. */
export function renderIcs(entries: readonly CalendarEntry[], options: IcsOptions): string {
  const calendar = ical({
    name: options.name,
    prodId: { company: "open-parcels", product: "open-parcels", language: "EN" },
    method: ICalCalendarMethod.PUBLISH,
    // The configured zone is a display hint only. A calendar `timezone` would make the generator
    // write each time as the server process's wall clock under a TZID with no VTIMEZONE, so the
    // feed changed with the container's TZ; timed events are UTC instants instead.
    x: [{ key: "X-WR-TIMEZONE", value: options.timeZone }],
    // Calendar apps re-fetch at their own pace; this asks for at most hourly.
    ttl: 60 * 60,
  });
  for (const entry of entries) {
    const start = new Date(entry.start);
    const end = new Date(entry.end);
    const path =
      entry.parcelId === null ? `orders/${entry.orderId ?? ""}` : `parcels/${entry.parcelId}`;
    const parcelUrl =
      options.publicUrl === undefined ? null : new URL(path, options.publicUrl).toString();
    const carrier = findCarrier(loadRules(), entry.carrier)?.name ?? entry.carrier;
    const title = `${entry.title} (${carrier})`;
    const lines =
      entry.kind === "return_by"
        ? [`Order: ${entry.barcode}`, ...entry.details]
        : [`Carrier: ${carrier}`, `Tracking: ${entry.barcode}`];
    lines.push(`Status: ${entry.status.replaceAll("_", " ")}`);
    if (entry.kind === "return_by" && entry.url !== null) {
      lines.push(`Label: ${entry.url}`);
    }
    if (entry.pickupPoint !== null) {
      lines.push(`Pickup point: ${entry.pickupPoint}`);
    }
    calendar.createEvent({
      id: entry.uid,
      summary: summaryOf(entry, title),
      description: lines.join("\n"),
      ...(entry.allDay && entry.startDate !== null && entry.endDate !== null
        ? {
            allDay: true,
            start: utcDay(entry.startDate),
            end: utcDay(entry.endDate),
            timezone: null,
          }
        : { start, end }),
      ...(entry.pickupPoint === null ? {} : { location: entry.pickupPoint }),
      ...(parcelUrl === null ? {} : { url: parcelUrl }),
    });
  }
  return calendar.toString();
}
