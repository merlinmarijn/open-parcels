import type { LookupState, ParcelStatus, Connection, ConnectionState } from "../api/types";
import { t } from "../i18n";
import { formatNumber, UI_LOCALE } from "./locale";

export const STATUS_LABELS: Readonly<Record<ParcelStatus, string>> = t.common.parcelStatus;

export const LOOKUP_LABELS: Readonly<Record<LookupState, string>> = t.common.lookupState;

export const CONNECTION_STATE_LABELS: Readonly<Record<ConnectionState, string>> =
  t.common.connectionState;

export const CONNECTION_KIND_LABELS: Readonly<Record<Connection["kind"], string>> =
  t.common.connectionKind;

const locales = UI_LOCALE;
const dateTime = new Intl.DateTimeFormat(locales, { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat(locales, {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const timeOnly = new Intl.DateTimeFormat(locales, { timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat(locales, { numeric: "auto" });

export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTime.format(date);
}

/** What a parcel says about its expected delivery, as the API sends it. */
export interface ExpectedDelivery {
  readonly expected_from: string | null;
  readonly expected_to: string | null;
  /** Whole local days in the server's time zone; null when the window has times. */
  readonly expected_days: { readonly from: string; readonly to: string } | null;
}

/** A `YYYY-MM-DD` day as a date at noon in the browser's zone, so formatting keeps the day. */
function localDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1, 12);
}

/** "Today", "Tomorrow", "Yesterday" in the UI language, else "Thu, Nov 20". */
function dayName(date: Date, now = new Date()): string {
  const midnight = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(date) - midnight(now)) / 86_400_000);
  if (Math.abs(days) > 1) return dateOnly.format(date);
  const word = relative.format(days, "day");
  return word.charAt(0).toLocaleUpperCase(locales) + word.slice(1);
}

/**
 * The expected delivery in two short parts for a parcel row: the day in words ("Tomorrow") and
 * the time window when there is one ("10:00–12:00"). Null when nothing is expected.
 */
export function etaParts(
  parcel: ExpectedDelivery,
  now = new Date(),
): { readonly day: string; readonly time: string | null } | null {
  const days = parcel.expected_days;
  if (days !== null) {
    const first = dayName(localDay(days.from), now);
    return days.from === days.to
      ? { day: first, time: null }
      : { day: `${first} – ${dayName(localDay(days.to), now)}`, time: null };
  }
  const from = parcel.expected_from === null ? null : new Date(parcel.expected_from);
  const to = parcel.expected_to === null ? null : new Date(parcel.expected_to);
  const start = from ?? to;
  if (start === null) return null;
  if (from !== null && to !== null && from.toDateString() === to.toDateString()) {
    return { day: dayName(from, now), time: `${timeOnly.format(from)}–${timeOnly.format(to)}` };
  }
  if (from !== null && to !== null) {
    return { day: `${dayName(from, now)} – ${dayName(to, now)}`, time: null };
  }
  return { day: dayName(start, now), time: null };
}

/**
 * The expected delivery: whole days as the server's local days (OP-044), never shifted by the
 * browser's zone; else "Mon 3 Nov, 10:00–12:00", or one side only when the other is missing.
 */
export function formatExpected(parcel: ExpectedDelivery): string {
  const days = parcel.expected_days;
  if (days !== null) {
    return days.from === days.to
      ? dateOnly.format(localDay(days.from))
      : `${dateOnly.format(localDay(days.from))} – ${dateOnly.format(localDay(days.to))}`;
  }
  return formatWindow(parcel.expected_from, parcel.expected_to);
}

/** "Mon 3 Nov, 10:00–12:00", or one side only when the other is missing. */
function formatWindow(from: string | null, to: string | null): string {
  if (from === null && to === null) {
    return "—";
  }
  const start = from === null ? null : new Date(from);
  const end = to === null ? null : new Date(to);
  if (start !== null && end !== null) {
    // Whole days come as `expected_days`; a window here always has times.
    const sameDay = start.toDateString() === end.toDateString();
    return sameDay
      ? `${dateOnly.format(start)}, ${timeOnly.format(start)}–${timeOnly.format(end)}`
      : `${dateOnly.format(start)} – ${dateOnly.format(end)}`;
  }
  const only = start ?? end;
  return only === null ? "—" : dateOnly.format(only);
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

export function formatRelative(value: string | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) {
    return t.common.never;
  }
  const diff = new Date(value).getTime() - now;
  if (Number.isNaN(diff)) {
    return value;
  }
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) {
      return relative.format(Math.round(diff / ms), unit);
    }
  }
  return t.common.justNow;
}

/**
 * "Found by the carrier 2 days ago, last asked 1 hour ago". Unknown times are left out rather
 * than called "never"; a parcel never asked says so.
 */
export function describeLookup(
  lookup: {
    readonly state: LookupState;
    readonly since: string | null;
    readonly checked_at: string | null;
  },
  now = Date.now(),
): string {
  const since = lookup.since === null ? "" : ` ${formatRelative(lookup.since, now)}`;
  const asked =
    lookup.checked_at === null
      ? t.common.notAskedYet
      : t.common.lastAsked(formatRelative(lookup.checked_at, now));
  return `${t.common.lookupPhrase[lookup.state]}${since}, ${asked}`;
}

const plainMoney = new Intl.NumberFormat(UI_LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
});

/** An amount in its currency; a bare number when the currency is unknown, never a guessed one (OP-151). */
export function formatMoney(amount: number, currency: string | null): string {
  if (currency === null) return plainMoney.format(amount);
  try {
    return new Intl.NumberFormat(UI_LOCALE, { style: "currency", currency }).format(amount);
  } catch {
    return plainMoney.format(amount);
  }
}

/** "512 B", "3.4 MB", "120 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value < 10 ? 1 : 0;
  const number = new Intl.NumberFormat(UI_LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  return `${number} ${units[unit] ?? "TB"}`;
}
