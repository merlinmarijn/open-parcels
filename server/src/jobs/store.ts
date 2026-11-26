import type { Kysely } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { Database, JobRow, JobTable } from "../db/schema.js";
import { appendEvent } from "../events/bus.js";
import type { EventBus } from "../events/bus.js";
import type { EventType } from "../events/types.js";

/** Storage and live events of jobs (`docs/connection-actions-and-jobs.md` §3–4). */

export type JobState = JobTable["state"];
export const JOB_STATES = [
  "queued",
  "running",
  "paused",
  "done",
  "partial",
  "failed",
  "cancelled",
] as const satisfies readonly JobState[];

/** A connection has at most one job in these states. */
const ACTIVE_STATES: readonly JobState[] = ["queued", "running", "paused"];
/** States a job may be resumed from (continuing from its checkpoint). */
export const RESUMABLE_STATES: readonly JobState[] = ["paused", "failed", "partial", "cancelled"];

export interface JobProgressBody {
  readonly done: number | null;
  readonly total: number | null;
  readonly phase: string | null;
}

/** A job as the API and the live events show it. */
export interface JobBody {
  readonly id: string;
  readonly connection_id: string;
  readonly provider: string;
  readonly action: string;
  readonly state: JobState;
  readonly reason: string | null;
  readonly progress: JobProgressBody;
  readonly summary: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly updated_at: string;
  readonly finished_at: string | null;
  readonly resume_at: string | null;
}

export const NO_PROGRESS: JobProgressBody = { done: null, total: null, phase: null };

export function jobBody(row: JobRow): JobBody {
  return {
    id: row.id,
    connection_id: row.connection_id,
    provider: row.provider,
    action: row.action,
    state: row.state,
    reason: row.reason,
    progress: { ...NO_PROGRESS, ...(JSON.parse(row.progress) as Partial<JobProgressBody>) },
    summary: row.summary,
    created_at: row.created_at,
    started_at: row.started_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
    resume_at: row.resume_at,
  };
}

/** The checkpoint's associated data: a blob copied to another job fails to decrypt. */
export const checkpointAad = (jobId: string): string => `job:${jobId}:checkpoint`;

export class JobStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  get(id: string): Promise<JobRow | undefined> {
    return this.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();
  }

  list(filter: { connectionId?: string; state?: JobState }): Promise<JobRow[]> {
    let query = this.db.selectFrom("jobs").selectAll();
    if (filter.connectionId !== undefined) {
      query = query.where("connection_id", "=", filter.connectionId);
    }
    if (filter.state !== undefined) {
      query = query.where("state", "=", filter.state);
    }
    return query.orderBy("created_at", "desc").orderBy("id", "desc").limit(200).execute();
  }

  /** The connection's queued, running or paused job, if any. */
  active(connectionId: string): Promise<JobRow | undefined> {
    return this.db
      .selectFrom("jobs")
      .selectAll()
      .where("connection_id", "=", connectionId)
      .where("state", "in", ACTIVE_STATES)
      .executeTakeFirst();
  }

  /** When the action last finished as `done` on this connection, or undefined. */
  async lastDone(connectionId: string, action: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom("jobs")
      .select("finished_at")
      .where("connection_id", "=", connectionId)
      .where("action", "=", action)
      .where("state", "=", "done")
      .orderBy("finished_at", "desc")
      .executeTakeFirst();
    return row?.finished_at ?? undefined;
  }

  queued(): Promise<JobRow[]> {
    return this.db
      .selectFrom("jobs")
      .selectAll()
      .where("state", "=", "queued")
      .orderBy("created_at")
      .execute();
  }

  /** Paused jobs whose `resume_at` has come go back to the queue; returns the next later one. */
  async resumeDue(): Promise<string | undefined> {
    const now = isoNow(this.clock);
    await this.db
      .updateTable("jobs")
      .set({ state: "queued", resume_at: null, updated_at: now })
      .where("state", "=", "paused")
      .where("resume_at", "is not", null)
      .where("resume_at", "<=", now)
      .execute();
    const next = await this.db
      .selectFrom("jobs")
      .select((eb) => eb.fn.min("resume_at").as("next"))
      .where("state", "=", "paused")
      .executeTakeFirst();
    return next?.next ?? undefined;
  }

  /** Jobs a stopped server left `running` continue from their checkpoint. */
  async requeueInterrupted(): Promise<void> {
    await this.db
      .updateTable("jobs")
      .set({ state: "queued", updated_at: isoNow(this.clock) })
      .where("state", "=", "running")
      .execute();
  }

  async insert(row: JobRow, event: EventType): Promise<JobRow> {
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto("jobs").values(row).execute();
      await this.#event(trx, row, event);
    });
    await this.bus.notify();
    return row;
  }

  /**
   * Changes a job and, with `event`, tells clients. Returns the job as stored afterwards, or
   * undefined when it is gone (its connection was deleted) or was not in one of `from`.
   */
  async update(
    id: string,
    changes: Partial<Omit<JobRow, "id" | "connection_id" | "provider" | "action" | "created_at">>,
    event?: EventType,
    from?: readonly JobState[],
  ): Promise<JobRow | undefined> {
    const updated = await this.db.transaction().execute(async (trx) => {
      let query = trx
        .updateTable("jobs")
        .set({ ...changes, updated_at: isoNow(this.clock) })
        .where("id", "=", id);
      if (from !== undefined) query = query.where("state", "in", from);
      const result = await query.executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) return undefined;
      const row = await trx.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();
      if (row !== undefined && event !== undefined) await this.#event(trx, row, event);
      return row;
    });
    if (event !== undefined) await this.bus.notify();
    return updated;
  }

  async #event(
    trx: Parameters<typeof appendEvent>[0],
    row: JobRow,
    type: EventType,
  ): Promise<void> {
    const connection = await trx
      .selectFrom("connections")
      .select(["id", "provider", "label", "kind"])
      .where("id", "=", row.connection_id)
      .executeTakeFirst();
    await appendEvent(trx, this.clock, {
      type,
      parcelId: null,
      payload: { job: jobBody(row), connection: connection ?? null },
    });
  }
}
