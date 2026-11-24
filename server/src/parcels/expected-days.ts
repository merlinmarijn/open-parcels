import { localParts, type LocalParts } from "../engine/tz.js";

/** The expected delivery as local days, `from` and `to` inclusive (`YYYY-MM-DD`). */
export interface ExpectedDays {
  readonly from: string;
  readonly to: string;
}

function isoDay(parts: LocalParts): string {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

/** The local day before `parts`, for an exclusive end at midnight. */
function dayBefore(parts: LocalParts): string {
  const noon = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12) - 24 * 60 * 60 * 1000);
  return noon.toISOString().slice(0, 10);
}

/**
 * The expected delivery as whole local days in `timeZone`, or null when it carries times (OP-044).
 *
 * It is whole days when `from` is at local midnight and `to` is missing (that one day), at a later
 * local midnight (exclusive: the day before it is the last) or at 23:59 (inclusive). Clients show
 * these days as they are instead of converting the times into their own zone, where midnight
 * could fall on another day.
 */
export function expectedDays(
  from: string | null,
  to: string | null,
  timeZone: string,
): ExpectedDays | null {
  if (from === null) {
    return null;
  }
  const start = new Date(from);
  const first = localParts(start, timeZone);
  if (first.hour !== 0 || first.minute !== 0) {
    return null;
  }
  if (to === null) {
    return { from: isoDay(first), to: isoDay(first) };
  }
  const end = new Date(to);
  if (end <= start) {
    return null;
  }
  const last = localParts(end, timeZone);
  if (last.hour === 0 && last.minute === 0) {
    return { from: isoDay(first), to: dayBefore(last) };
  }
  if (last.hour === 23 && last.minute === 59) {
    return { from: isoDay(first), to: isoDay(last) };
  }
  return null;
}
