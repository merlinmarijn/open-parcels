import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parcel } from "../test/helpers";
import type { ParcelDetail } from "./types";
import { LIVE_LIST_REFRESH_MS, useLiveUpdates } from "./events";
import { keys } from "./queries";

/** Stands in for the browser's EventSource, which jsdom lacks: tests push events by hand. */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    super();
    FakeEventSource.opened.push(this);
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  fail(closed: boolean): void {
    this.readyState = closed ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.onerror?.();
  }

  emit(type: string, data: unknown): void {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

const ID = "00000000-0000-4000-8000-0000000000e1";

let client: QueryClient;
let invalidated: unknown[][];
let removed: unknown[][];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.opened = [];
  client = new QueryClient();
  invalidated = [];
  removed = [];
  vi.spyOn(client, "invalidateQueries").mockImplementation((filters) => {
    invalidated.push([...(filters?.queryKey ?? ["*"])]);
    return Promise.resolve();
  });
  vi.spyOn(client, "removeQueries").mockImplementation((filters) => {
    removed.push([...(filters?.queryKey ?? [])]);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function start(enabled = true) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(({ on }) => useLiveUpdates(on), {
    wrapper,
    initialProps: { on: enabled },
  });
  const stream = (): FakeEventSource => {
    const last = FakeEventSource.opened.at(-1);
    if (last === undefined) throw new Error("No stream was opened.");
    return last;
  };
  return { hook, stream };
}

const LISTS = [["parcels"], ["calendar"], ["orders"]];

describe("useLiveUpdates (OP-163)", () => {
  it("opens no stream while disabled, and one with credentials below the base when enabled", () => {
    const { hook } = start(false);
    expect(FakeEventSource.opened).toHaveLength(0);
    hook.rerender({ on: true });
    expect(FakeEventSource.opened).toHaveLength(1);
    expect(FakeEventSource.opened[0]?.url).toMatch(/\/api\/v1\/events$/u);
    expect(FakeEventSource.opened[0]?.init).toEqual({ withCredentials: true });
  });

  it.each([
    ["parcel.status_changed", { parcel: { id: ID } }, [...LISTS, keys.parcel(ID)], []],
    ["parcel.registered", { parcel: { id: ID } }, [...LISTS, keys.parcel(ID)], []],
    ["parcel.deleted", { id: ID }, LISTS, [keys.parcel(ID)]],
    // Archived by retention: the lists drop it (OP-052).
    ["parcel.archived", { parcel: { id: ID } }, [...LISTS, keys.parcel(ID)], []],
    ["connection.run_finished", { id: "c1" }, [keys.connections, keys.status, keys.parcels], []],
    ["connection.removed", { id: "c1" }, [keys.connections, keys.status, keys.parcels], []],
    ["backup.finished", { ok: false }, [keys.backups, keys.status], []],
    ["settings.updated", {}, [["settings"], keys.parcels], []],
    // An order started by an email shows up without a reload (OP-052).
    ["order.created", { id: "o1" }, [keys.orders, keys.parcels], []],
    ["order.updated", { id: "o1" }, [keys.orders, keys.parcels], []],
    ["order.deleted", { id: "o1" }, [keys.orders, keys.parcels], [keys.order("o1")]],
    ["return.created", { id: "r1" }, [keys.returns, keys.orders, ["calendar"]], []],
    ["resync", {}, [["*"]], []],
  ])("refreshes what %s changes", (type, data, expectInvalidated, expectRemoved) => {
    const { stream } = start();
    act(() => {
      stream().emit(type, data);
    });
    expect(invalidated).toEqual(expectInvalidated);
    expect(removed).toEqual(expectRemoved);
  });

  it("refreshes the lists at most once a minute for live updates, the parcel every time", () => {
    const { stream } = start();
    act(() => {
      stream().emit("parcel.live_updated", { parcel: { id: ID } });
      stream().emit("parcel.live_updated", { parcel: { id: ID } });
    });
    expect(invalidated).toEqual([...LISTS, keys.parcel(ID), keys.parcel(ID)]);
    invalidated = [];
    act(() => {
      vi.advanceTimersByTime(LIVE_LIST_REFRESH_MS);
    });
    expect(invalidated).toEqual(LISTS);
  });

  it("moves the courier in the cached parcel without asking the server", () => {
    const onRoad: ParcelDetail = {
      ...parcel({ id: ID }),
      connections: [],
      live: {
        state: "en_route",
        stops_away: 5,
        latitude: 53,
        longitude: 9,
        accuracy: null,
        position_at: null,
        message: null,
        updated_at: "2026-11-24T09:00:00.000Z",
      },
    };
    client.setQueryData(keys.parcel(ID), onRoad);
    const { stream } = start();
    act(() => {
      stream().emit("parcel.live_position", {
        parcel_id: ID,
        latitude: 52.5,
        longitude: 13.4,
        accuracy: 10,
        position_at: "2026-11-18T10:00:00.000Z",
        stops_away: 2,
      });
      stream().emit("parcel.live_position", { parcel_id: ID, latitude: "bad" });
    });
    expect(client.getQueryData<ParcelDetail>(keys.parcel(ID))?.live).toMatchObject({
      latitude: 52.5,
      longitude: 13.4,
      stops_away: 2,
    });
    expect(invalidated).toEqual([]);
  });

  it("reports its state, and reopens a stream closed for good after a growing wait", () => {
    const { hook, stream } = start();
    expect(hook.result.current).toBe("connecting");
    act(() => {
      stream().open();
    });
    expect(hook.result.current).toBe("live");
    act(() => {
      stream().fail(false);
    });
    expect(hook.result.current).toBe("connecting");

    act(() => {
      stream().fail(true);
    });
    expect(hook.result.current).toBe("offline");
    expect(invalidated).toEqual([["session"]]);
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(FakeEventSource.opened).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeEventSource.opened).toHaveLength(2);
    expect(FakeEventSource.opened[0]?.readyState).toBe(FakeEventSource.CLOSED);

    // Closed again without ever opening: the wait doubles.
    act(() => {
      stream().fail(true);
    });
    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(FakeEventSource.opened).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeEventSource.opened).toHaveLength(3);
  });

  it("closes its stream on unmount", () => {
    const { hook, stream } = start();
    const open = stream();
    hook.unmount();
    expect(open.readyState).toBe(FakeEventSource.CLOSED);
  });
});
