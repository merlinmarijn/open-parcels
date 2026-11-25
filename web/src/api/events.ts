import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { SESSION_KEY } from "../auth/session";
import { apiUrl } from "./fetcher";
import type { GetApiV1Events200Event } from "./generated";
import type { ParcelDetail } from "./types";
import { settingsKey } from "../settings/home";
import { keys } from "./queries";

/** First wait before a stream the server closed is opened again; it doubles up to the maximum. */
const STREAM_RETRY_MS = 5_000;
const STREAM_RETRY_MAX_MS = 5 * 60_000;

type Reaction =
  | "parcel"
  | "connection"
  | "order"
  | "return"
  | "settings"
  | "backup"
  | "health"
  | "token"
  | "resync"
  | "position";

/**
 * What each message of the stream refreshes. Typed against the server's list (generated from its
 * API document), so a message type the server adds does not compile until it is handled here.
 */
const REACTIONS = {
  "parcel.registered": "parcel",
  "parcel.status_changed": "parcel",
  "parcel.delivered": "parcel",
  "parcel.delivery_time_changed": "parcel",
  "parcel.sending_registered": "parcel",
  "parcel.sending_delivered": "parcel",
  "parcel.live_updated": "parcel",
  "parcel.location_changed": "parcel",
  "parcel.removed": "parcel",
  "parcel.deleted": "parcel",
  "parcel.archived": "parcel",
  "parcel.live_position": "position",
  // Connections: added, renamed, a state change, a finished run (run times, counts), a removal.
  "connection.added": "connection",
  "connection.updated": "connection",
  "connection.state_changed": "connection",
  "connection.run_finished": "connection",
  "connection.removed": "connection",
  // An order created (from an email), renamed, (un)archived by hand, or deleted.
  "order.created": "order",
  "order.updated": "order",
  "order.deleted": "order",
  // A return started or changed: the returns list, its order and the calendar's deadlines.
  "return.created": "return",
  "return.updated": "return",
  "settings.updated": "settings",
  // A backup finished or failed: the backup card and the status page.
  "backup.finished": "backup",
  // The server's health or an inbox's connection changed: the status page.
  "health.changed": "health",
  // A token or token login was used: its "last used" on the tokens page.
  "token.used": "token",
  resync: "resync",
  // Nothing on screen depends on these.
  "vocab.unknown": null,
  ready: null,
} as const satisfies Record<GetApiV1Events200Event, Reaction | null>;

export type LiveState = "connecting" | "live" | "offline";

/** Live position updates arrive every 30 s per parcel; the lists follow them at most this often. */
export const LIVE_LIST_REFRESH_MS = 60_000;

/**
 * Runs `refresh` at once when it has not run for `intervalMs`, otherwise once at the end of that
 * window, so a burst of requests costs at most one run per window and the last one is never lost.
 */
export function throttled(
  refresh: () => void,
  intervalMs: number,
  now: () => number = Date.now,
): { request: () => void; cancel: () => void } {
  let last = Number.NEGATIVE_INFINITY;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const run = (): void => {
    pending = undefined;
    last = now();
    refresh();
  };
  return {
    request: () => {
      const wait = last + intervalMs - now();
      if (wait <= 0) {
        run();
      } else {
        pending ??= setTimeout(run, wait);
      }
    },
    cancel: () => {
      if (pending !== undefined) {
        clearTimeout(pending);
        pending = undefined;
      }
    },
  };
}

interface EventPayload {
  readonly id?: unknown;
  readonly parcel?: { readonly id?: unknown };
}

/** A courier position from `parcel.live_position`; never stored, never replayed. */
export interface LivePositionMessage {
  readonly parcel_id: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy: number | null;
  readonly position_at: string | null;
  readonly stops_away: number | null;
}

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || typeof value === "number";

export function parseLivePosition(data: string): LivePositionMessage | null {
  try {
    // Every field is checked below; nothing is trusted from the cast (as in `subjectIdOf`).
    const payload = JSON.parse(data) as Partial<Record<keyof LivePositionMessage, unknown>> | null;
    if (typeof payload !== "object" || payload === null) return null;
    const { parcel_id, latitude, longitude, accuracy, position_at, stops_away } = payload;
    if (typeof parcel_id !== "string" || typeof latitude !== "number") return null;
    if (typeof longitude !== "number" || !isNumberOrNull(accuracy)) return null;
    if (!isNumberOrNull(stops_away)) return null;
    if (position_at !== null && typeof position_at !== "string") return null;
    return { parcel_id, latitude, longitude, accuracy, position_at, stops_away };
  } catch {
    return null;
  }
}

/**
 * The parcel with the courier moved to the new position, without asking the server again
 * (OP-061). A parcel not on the road (no `live`) is left alone.
 */
export function withLivePosition(parcel: ParcelDetail, message: LivePositionMessage): ParcelDetail {
  if (parcel.live === null) return parcel;
  return {
    ...parcel,
    live: {
      ...parcel.live,
      latitude: message.latitude,
      longitude: message.longitude,
      accuracy: message.accuracy,
      position_at: message.position_at,
      stops_away: message.stops_away,
    },
    location: {
      latitude: message.latitude,
      longitude: message.longitude,
      source: "courier",
      precision: "exact",
      name: null,
      address: null,
      at: message.position_at,
    },
  };
}

function subjectIdOf(data: string): string | undefined {
  try {
    const payload = JSON.parse(data) as EventPayload;
    const id = payload.parcel?.id ?? payload.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Subscribes to the server's event stream and refreshes the affected queries. EventSource
 * reconnects by itself and sends `Last-Event-ID`, so nothing is missed across short drops.
 */
export function useLiveUpdates(enabled: boolean): LiveState {
  const client = useQueryClient();
  const [state, setState] = useState<LiveState>("connecting");
  // Bumped to open a new stream after the server closed one for good (OP-043).
  const [generation, setGeneration] = useState(0);
  const closedRuns = useRef(0);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") {
      return undefined;
    }
    const stream = new EventSource(apiUrl("/api/v1/events"), { withCredentials: true });
    const refreshLists = (): void => {
      void client.invalidateQueries({ queryKey: keys.parcels });
      void client.invalidateQueries({ queryKey: ["calendar"] });
      // An order's status and archiving follow its parcels.
      void client.invalidateQueries({ queryKey: keys.orders });
    };
    // A live update changes one parcel's courier position, not what the lists show.
    const liveLists = throttled(refreshLists, LIVE_LIST_REFRESH_MS);
    const onParcel = (event: MessageEvent<string>): void => {
      if (event.type === "parcel.live_updated") {
        liveLists.request();
      } else {
        refreshLists();
      }
      const id = subjectIdOf(event.data);
      if (id !== undefined && event.type === "parcel.deleted") {
        client.removeQueries({ queryKey: keys.parcel(id) });
      } else if (id !== undefined) {
        void client.invalidateQueries({ queryKey: keys.parcel(id) });
      }
    };
    const onConnection = (): void => {
      void client.invalidateQueries({ queryKey: keys.connections });
      void client.invalidateQueries({ queryKey: keys.status });
      // A run may have changed parcels without a parcel event (lookup state, last seen), and a
      // removed connection takes its links with it.
      void client.invalidateQueries({ queryKey: keys.parcels });
    };
    let reopen: ReturnType<typeof setTimeout> | undefined;
    stream.onopen = () => {
      closedRuns.current = 0;
      setState("live");
    };
    stream.onerror = () => {
      if (stream.readyState !== EventSource.CLOSED) {
        setState("connecting");
        return;
      }
      // Closed for good (an ended session, a server error on reconnect): ask for the session,
      // which shows the sign-in page when needed, and open a new stream after a growing wait.
      setState("offline");
      void client.invalidateQueries({ queryKey: SESSION_KEY });
      const wait = Math.min(STREAM_RETRY_MS * 2 ** closedRuns.current, STREAM_RETRY_MAX_MS);
      closedRuns.current += 1;
      reopen = setTimeout(() => {
        setGeneration((value) => value + 1);
      }, wait);
    };
    // A changed setting (home, how parcels are named) changes every parcel's view.
    const onSettings = (): void => {
      void client.invalidateQueries({ queryKey: settingsKey });
      void client.invalidateQueries({ queryKey: keys.parcels });
    };
    const onOrder = (event: MessageEvent<string>): void => {
      const id = subjectIdOf(event.data);
      if (id !== undefined && event.type === "order.deleted") {
        client.removeQueries({ queryKey: keys.order(id) });
      }
      // Orders and the parcels that name them.
      void client.invalidateQueries({ queryKey: keys.orders });
      void client.invalidateQueries({ queryKey: keys.parcels });
    };
    const onReturn = (): void => {
      void client.invalidateQueries({ queryKey: keys.returns });
      void client.invalidateQueries({ queryKey: keys.orders });
      void client.invalidateQueries({ queryKey: ["calendar"] });
    };
    const onBackup = (): void => {
      void client.invalidateQueries({ queryKey: keys.backups });
      void client.invalidateQueries({ queryKey: keys.status });
    };
    const onHealth = (): void => {
      void client.invalidateQueries({ queryKey: keys.status });
    };
    const onToken = (): void => {
      void client.invalidateQueries({ queryKey: keys.tokens });
      void client.invalidateQueries({ queryKey: keys.logins });
    };
    // The server could not replay what was missed (too old, or a reset database): reload all.
    const onResync = (): void => {
      void client.invalidateQueries();
    };
    const onPosition = (event: MessageEvent<string>): void => {
      const message = parseLivePosition(event.data);
      if (message === null) return;
      client.setQueryData<ParcelDetail>(keys.parcel(message.parcel_id), (parcel) =>
        parcel === undefined ? undefined : withLivePosition(parcel, message),
      );
    };
    const handlers: Record<Reaction, (event: MessageEvent<string>) => void> = {
      parcel: onParcel,
      connection: onConnection,
      order: onOrder,
      return: onReturn,
      settings: onSettings,
      backup: onBackup,
      health: onHealth,
      token: onToken,
      resync: onResync,
      position: onPosition,
    };
    for (const [type, reaction] of Object.entries(REACTIONS)) {
      if (reaction !== null) stream.addEventListener(type, handlers[reaction]);
    }
    return () => {
      liveLists.cancel();
      clearTimeout(reopen);
      stream.close();
    };
  }, [client, enabled, generation]);

  return state;
}
