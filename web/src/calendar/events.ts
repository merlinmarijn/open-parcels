import type { EventInput } from "@fullcalendar/core";
import type { CalendarEntry } from "../api/types";

/**
 * One calendar entry as a FullCalendar event. All-day entries use the server's local days
 * (`2026-11-20`), never the instants, so they land on the right day whatever time zone the
 * browser reports (LibreWolf, for one, reports UTC).
 */
export function toCalendarEvent(entry: CalendarEntry, carrierName: string): EventInput {
  const span =
    entry.all_day && entry.start_date !== null && entry.end_date !== null
      ? { start: entry.start_date, end: entry.end_date, allDay: true }
      : { start: entry.start, end: entry.end, allDay: false };
  // The title is the label, first item or barcode; the carrier is added here, once. A return's
  // deadline says so and lists where to hand it in and what it costs.
  const title =
    entry.kind === "return_by"
      ? [`Return by: ${entry.title}`, ...entry.details].join(" · ")
      : `${entry.title} · ${carrierName}`;
  return {
    id: entry.uid,
    title,
    ...span,
    classNames: [`cal-${entry.kind}`, ...(entry.late ? ["cal-late"] : [])],
    extendedProps: { parcelId: entry.parcel_id, orderId: entry.order_id },
  };
}
