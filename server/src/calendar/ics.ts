import ical, { ICalCalendarMethod } from "ical-generator";
import { findCarrier, loadRules } from "open-parcels-rules";
import type { Language } from "../i18n/language.js";
import { costText, dropOffText, ICS_TEXTS, statusText, type IcsTexts } from "./ics-texts.js";
import type { CalendarEntry } from "./service.js";

/** A `YYYY-MM-DD` day as a UTC-midnight Date: what an all-day DTSTART/DTEND needs. */
function utcDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function summaryOf(texts: IcsTexts, entry: CalendarEntry, title: string): string {
  switch (entry.kind) {
    case "delivered":
      return texts.delivered(title);
    case "return_by":
      return texts.returnBy(entry.startDate ?? entry.start.slice(0, 10), entry.title);
    case "expected":
      return title;
  }
}

export interface IcsOptions {
  readonly timeZone: string;
  readonly language: Language;
  readonly publicUrl: URL | undefined;
}

/** The description lines of one event, in the feed's language. */
function descriptionOf(
  texts: IcsTexts,
  language: Language,
  entry: CalendarEntry,
  carrier: string,
): string[] {
  if (entry.kind !== "return_by") {
    const lines = [
      `${texts.carrier}: ${carrier}`,
      `${texts.trackingNumber}: ${entry.trackingNumber}`,
      `${texts.status}: ${statusText(texts, "parcel", entry.status)}`,
    ];
    return entry.pickupPoint === null
      ? lines
      : [...lines, `${texts.pickupPoint}: ${entry.pickupPoint}`];
  }
  const cost = costText(texts, language, entry.cost);
  return [
    `${texts.order}: ${entry.trackingNumber}`,
    ...entry.dropOff.map((option) => `${texts.dropOff}: ${dropOffText(texts, option)}`),
    ...(cost === null ? [] : [cost]),
    `${texts.status}: ${statusText(texts, "return", entry.status)}`,
    ...(entry.url === null ? [] : [`${texts.label}: ${entry.url}`]),
  ];
}

/** Renders entries as an iCalendar feed in one language. Event UIDs are stable per parcel. */
export function renderIcs(entries: readonly CalendarEntry[], options: IcsOptions): string {
  const texts = ICS_TEXTS[options.language];
  const calendar = ical({
    name: texts.feedName,
    prodId: {
      company: "open-parcels",
      product: "open-parcels",
      language: options.language.toUpperCase(),
    },
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
    calendar.createEvent({
      id: entry.uid,
      summary: summaryOf(texts, entry, title),
      description: descriptionOf(texts, options.language, entry, carrier).join("\n"),
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
