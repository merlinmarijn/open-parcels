import type { EventType, OutboxEvent } from "./types.js";

/**
 * Live event types renamed to the glossary's terms (`docs/glossary.md`). For one release every
 * such live event is also sent under its old name, with the old payload keys next to the new
 * ones, so clients built for the old names keep working. Deprecated.
 */
const LEGACY_TYPES: Partial<Record<EventType, string>> = {
  "parcel.sending_registered": "parcel.outgoing_registered",
  "parcel.sending_delivered": "parcel.outgoing_delivered",
  "connection.added": "source.added",
  "connection.updated": "source.updated",
  "connection.state_changed": "source.state_changed",
  "connection.run_finished": "source.run_finished",
  "connection.removed": "source.removed",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The payload with `source` (and its `plugin`) next to `connection` (and its `provider`). */
function legacyPayload(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload["connection"])) {
    return payload;
  }
  const connection = payload["connection"];
  return { ...payload, source: { ...connection, plugin: connection["provider"] } };
}

/** The deprecated twin of a live event, or undefined when its name did not change. */
export function legacyTwin(
  event: Pick<OutboxEvent, "type" | "payload">,
): { readonly type: string; readonly payload: unknown } | undefined {
  const type = LEGACY_TYPES[event.type];
  return type === undefined ? undefined : { type, payload: legacyPayload(event.payload) };
}
