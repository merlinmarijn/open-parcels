import { describe, expect, it } from "vitest";
import { formatExpected } from "./format";

const day = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

describe("formatExpected (OP-044)", () => {
  it("shows whole days as the server's local days, whatever the times say in this zone", () => {
    // Midnight in Berlin is 23:00 UTC the day before; the server's days win.
    const text = formatExpected({
      expected_from: "2026-11-16T23:00:00.000Z",
      expected_to: "2026-11-17T22:59:00.000Z",
      expected_days: { from: "2026-11-17", to: "2026-11-17" },
    });
    expect(text).toBe(day.format(new Date(2026, 10, 17, 12)));
  });

  it("shows a range of days from the first to the last", () => {
    const text = formatExpected({
      expected_from: "2026-11-16T23:00:00.000Z",
      expected_to: "2026-11-19T23:00:00.000Z",
      expected_days: { from: "2026-11-17", to: "2026-11-19" },
    });
    expect(text).toBe(
      `${day.format(new Date(2026, 10, 17, 12))} – ${day.format(new Date(2026, 10, 19, 12))}`,
    );
  });

  it("says nothing is known without a window", () => {
    expect(formatExpected({ expected_from: null, expected_to: null, expected_days: null })).toBe(
      "—",
    );
  });
});
