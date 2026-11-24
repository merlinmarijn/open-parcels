import { describe, expect, it } from "vitest";
import { expectedDays } from "../../src/parcels/expected-days.js";

const BERLIN = "Europe/Berlin";

describe("expectedDays (OP-044)", () => {
  it("gives one local day for a date without a time", () => {
    expect(expectedDays("2026-11-16T23:00:00.000Z", null, BERLIN)).toEqual({
      from: "2026-11-17",
      to: "2026-11-17",
    });
  });

  it("reads an end at 23:59 as inclusive and an end at midnight as exclusive", () => {
    expect(expectedDays("2026-11-16T23:00:00.000Z", "2026-11-18T22:59:00.000Z", BERLIN)).toEqual({
      from: "2026-11-17",
      to: "2026-11-18",
    });
    expect(expectedDays("2026-11-16T23:00:00.000Z", "2026-11-18T23:00:00.000Z", BERLIN)).toEqual({
      from: "2026-11-17",
      to: "2026-11-18",
    });
  });

  it("keeps the local day across a daylight-saving change", () => {
    // 29 March 2026: Berlin moves to summer time; midnight of the 30th is 22:00 UTC.
    expect(expectedDays("2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z", BERLIN)).toEqual({
      from: "2026-03-29",
      to: "2026-03-29",
    });
  });

  it("is null for a window with times, a start that is not midnight, or no start", () => {
    expect(expectedDays("2026-11-17T09:00:00.000Z", "2026-11-17T11:00:00.000Z", BERLIN)).toBeNull();
    expect(expectedDays("2026-11-16T23:00:00.000Z", "2026-11-17T12:00:00.000Z", BERLIN)).toBeNull();
    expect(expectedDays(null, "2026-11-17T22:59:00.000Z", BERLIN)).toBeNull();
    // Midnight in UTC is 01:00 in Berlin: not a whole day there.
    expect(expectedDays("2026-11-17T00:00:00.000Z", null, BERLIN)).toBeNull();
  });
});
