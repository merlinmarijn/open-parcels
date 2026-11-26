/**
 * Canonical event types. The parcel ones follow the Home Assistant suite's contract: the hop to
 * `delivered` fires only `parcel.delivered`, never also `parcel.status_changed`.
 */
export const EVENT_TYPES = [
  "parcel.registered",
  "parcel.status_changed",
  "parcel.delivered",
  "parcel.delivery_time_changed",
  "parcel.sending_registered",
  "parcel.sending_delivered",
  "parcel.live_updated",
  "parcel.location_changed",
  "parcel.removed",
  "parcel.deleted",
  "parcel.archived",
  "connection.added",
  "connection.updated",
  "connection.state_changed",
  "connection.run_finished",
  "connection.removed",
  "job.queued",
  "job.started",
  "job.progress",
  "job.paused",
  "job.finished",
  "order.created",
  "order.updated",
  "order.deleted",
  "return.created",
  "return.updated",
  "settings.updated",
  "backup.finished",
  "health.changed",
  "token.used",
  "vocab.unknown",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface OutboxEvent {
  readonly seq: number;
  readonly type: EventType;
  readonly parcelId: string | null;
  readonly payload: unknown;
  readonly createdAt: string;
}
