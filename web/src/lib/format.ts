import type { LookupState, ParcelStatus, Connection, ConnectionState } from "../api/types";
import { UI_LOCALE } from "./locale";

export const STATUS_LABELS: Readonly<Record<ParcelStatus, string>> = {
  registered: "Registered",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  at_pickup_point: "At pickup point",
  delivered: "Delivered",
  returning: "Returning",
  problem: "Problem",
  unknown: "Unknown",
};

export const LOOKUP_LABELS: Readonly<Record<LookupState, string>> = {
  pending: "Waiting for carrier",
  found: "Found",
  not_found: "Not found by carrier",
};

export const CONNECTION_STATE_LABELS: Readonly<Record<ConnectionState, string>> = {
  ok: "OK",
  idle: "Idle",
  needs_sign_in: "Needs sign-in",
  error: "Error",
  disabled: "Disabled",
};

export const CONNECTION_KIND_LABELS: Readonly<Record<Connection["kind"], string>> = {
  account: "account",
  tracking: "tracking",
  shop: "shop",
  mail: "inbox",
};

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
    return "never";
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
  return "just now";
}

const LOOKUP_PHRASES: Readonly<Record<LookupState, string>> = {
  pending: "Waiting for the carrier",
  found: "Found by the carrier",
  not_found: "Not found by the carrier",
};

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
      ? "not asked yet"
      : `last asked ${formatRelative(lookup.checked_at, now)}`;
  return `${LOOKUP_PHRASES[lookup.state]}${since}, ${asked}`;
}

/** An amount in its currency; a bare number when the currency is unknown, never a guessed one (OP-151). */
export function formatMoney(amount: number, currency: string | null): string {
  if (currency === null) return amount.toFixed(2);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return amount.toFixed(2);
  }
}
