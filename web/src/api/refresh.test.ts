import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLivePosition, throttled, withLivePosition } from "./events";
import { parcel } from "../test/helpers";
import { parseRetryAfter } from "./fetcher";
import { allPages, invalidateParcelViews } from "./queries";

describe("refreshing after a parcel edit", () => {
  it("refreshes the calendar and the orders too, not only the lists", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    await invalidateParcelViews(client);
    // Orders follow their parcels' status and archiving.
    expect(spy.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["parcels"],
      ["calendar"],
      ["orders"],
    ]);
  });
});

describe("list refreshes for live updates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("run at most once a window, and the last request is never lost", () => {
    const refresh = vi.fn();
    const lists = throttled(refresh, 60_000);
    lists.request();
    expect(refresh).toHaveBeenCalledTimes(1);
    // Ten parcels' live updates within the window: one refresh at its end, not ten.
    for (let step = 0; step < 10; step += 1) {
      vi.advanceTimersByTime(5_000);
      lists.request();
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(120_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does nothing more once cancelled", () => {
    const refresh = vi.fn();
    const lists = throttled(refresh, 60_000);
    lists.request();
    lists.request();
    lists.cancel();
    vi.advanceTimersByTime(120_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("reading a paged list", () => {
  it("reads pages until one comes back short, so no list stops at one page (OP-064)", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => index);
    const offsets: number[] = [];
    const all = await allPages(2, (offset) => {
      offsets.push(offset);
      return Promise.resolve(rows.slice(offset, offset + 2));
    });
    expect(all).toEqual(rows);
    expect(offsets).toEqual([0, 2, 4]);
  });
});

describe("Retry-After (OP-041)", () => {
  it("reads seconds and HTTP dates", () => {
    const now = Date.parse("2026-11-24T10:00:00.000Z");
    expect(parseRetryAfter("30", now)).toBe(30);
    expect(parseRetryAfter("Tue, 24 Nov 2026 10:01:00 GMT", now)).toBe(60);
    expect(parseRetryAfter("Tue, 24 Nov 2026 09:00:00 GMT", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe("a courier position from the live stream (OP-061)", () => {
  const message = {
    parcel_id: "00000000-0000-4000-8000-000000000001",
    latitude: 53.5,
    longitude: 10,
    accuracy: 20,
    position_at: "2026-11-24T10:00:00.000Z",
    stops_away: 3,
  };

  it("is read only when every field has its type", () => {
    expect(parseLivePosition(JSON.stringify(message))).toEqual(message);
    expect(parseLivePosition(JSON.stringify({ ...message, latitude: "53" }))).toBeNull();
    expect(parseLivePosition("not json")).toBeNull();
  });

  it("moves the courier of a parcel on the road and leaves others alone", () => {
    const idle = { ...parcel(), sources: [] };
    expect(withLivePosition(idle, message)).toBe(idle);
    const onRoad = {
      ...idle,
      live: {
        state: "en_route" as const,
        stops_away: 5,
        latitude: 53,
        longitude: 9,
        accuracy: null,
        position_at: null,
        message: null,
        updated_at: "2026-11-24T09:00:00.000Z",
      },
    };
    const moved = withLivePosition(onRoad, message);
    expect(moved.live).toMatchObject({ latitude: 53.5, longitude: 10, stops_away: 3 });
    expect(moved.location).toMatchObject({ latitude: 53.5, longitude: 10, source: "courier" });
  });
});
