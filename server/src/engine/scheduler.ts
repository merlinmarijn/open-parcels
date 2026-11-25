import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { isoNow, type Clock } from "../clock.js";
import type { Database, ConnectionRow } from "../db/schema.js";
import { statusOrUnknown } from "../domain/parcel.js";
import {
  delayAfterFailure,
  nextRunAfterSuccess,
  staggerMinutes,
  type ActiveParcel,
} from "./policy.js";
import type { LiveTargetOfParcel, Reconciler } from "./reconciler.js";
import type { RunOutcome, ConnectionRunner } from "./runner.js";
import type { ConnectionService } from "./connections.js";

/** Upper bound on the timer, so removals are judged and clock changes picked up regularly. */
const MAX_SLEEP_MS = 5 * 60_000;
const DEFAULT_CONCURRENCY = 3;
/** An idle connection keeps running: the reason it had nothing to do may go away (a setting changed). */
const RUNNABLE_STATES: readonly ConnectionRow["state"][] = ["ok", "idle", "error"];
/** A scheduler whose last cycle is older than this has stopped looking at its connections. */
export const SCHEDULER_STALL_MS = 3 * MAX_SLEEP_MS;

/** What the status page shows of the scheduler. */
export interface SchedulerStatus {
  readonly running: boolean;
  /** Connection runs in progress now. */
  readonly inFlight: number;
  /** When the last cycle (due runs, then removals) finished; null before the first. */
  readonly lastCycleAt: string | null;
  /** Why the last cycle failed; null when it succeeded. */
  readonly lastError: string | null;
}

export interface SchedulerDeps {
  readonly db: Kysely<Database>;
  readonly runner: ConnectionRunner;
  readonly connections: ConnectionService;
  readonly reconciler: Reconciler;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly timeZone: string;
  /** Night-time quiet window, defaults to on. */
  readonly quietWindow?: boolean;
  readonly installId: string;
  readonly concurrency?: number;
  /** Called after each successful run with the parcels the carrier can show on a courier map. */
  readonly onRunSucceeded?: (
    connectionId: string,
    liveTargets: readonly LiveTargetOfParcel[],
  ) => void;
  /** A provider's fixed time between runs, if it has one. */
  readonly pollIntervalOf?: (provider: string) => number | null;
}

/**
 * Decides when each connection runs and runs it. One run per connection at a time, a few connections in
 * parallel. The next run time is stored, so a restart resumes the schedule instead of polling
 * every carrier at once.
 */
export class Scheduler {
  readonly #running = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = true;
  #lastCycleAt: string | null = null;
  #lastError: string | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  status(): SchedulerStatus {
    return {
      running: !this.#stopped,
      inFlight: this.#running.size,
      lastCycleAt: this.#lastCycleAt,
      lastError: this.#lastError,
    };
  }

  start(): void {
    this.#stopped = false;
    this.#arm(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Re-evaluates the timer, e.g. after a connection was asked to run now. */
  wake(): void {
    if (!this.#stopped) {
      this.#arm(0);
    }
  }

  #arm(delayMs: number): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#cycle().catch((error: unknown) => {
        this.deps.logger.error({ err: error }, "Scheduler cycle failed.");
        this.#lastError = error instanceof Error ? error.message : String(error);
        this.#arm(MAX_SLEEP_MS);
      });
    }, delayMs);
    // The scheduler must never keep the process alive on its own.
    this.#timer.unref();
  }

  async #cycle(): Promise<void> {
    await this.runDue();
    await this.deps.reconciler.judgeRemovals();
    this.#lastCycleAt = isoNow(this.deps.clock);
    this.#lastError = null;
    if (!this.#stopped) {
      this.#arm(await this.#sleepUntilNext());
    }
  }

  async #sleepUntilNext(): Promise<number> {
    const next = await this.deps.db
      .selectFrom("connections")
      .select((eb) => eb.fn.min("next_run_at").as("next"))
      .where("state", "in", RUNNABLE_STATES)
      .where("kind", "!=", "mail")
      .where("next_run_at", "is not", null)
      .executeTakeFirst();
    if (next?.next === undefined || next.next === null) {
      return MAX_SLEEP_MS;
    }
    return Math.max(
      0,
      Math.min(MAX_SLEEP_MS, Date.parse(next.next) - this.deps.clock.now().getTime()),
    );
  }

  /** Runs every connection that is due now. Returns how many ran. */
  async runDue(): Promise<number> {
    const due = await this.deps.db
      .selectFrom("connections")
      .selectAll()
      .where("state", "in", RUNNABLE_STATES)
      .where("kind", "!=", "mail")
      .where("next_run_at", "<=", isoNow(this.deps.clock))
      .orderBy("next_run_at")
      .execute();
    const queue = due.filter((connection) => !this.#running.has(connection.id));
    const count = queue.length;
    const workers = Array.from(
      { length: Math.min(this.deps.concurrency ?? DEFAULT_CONCURRENCY, queue.length) },
      async () => {
        for (let connection = queue.shift(); connection !== undefined; connection = queue.shift()) {
          await this.#runOne(connection);
        }
      },
    );
    await Promise.all(workers);
    return count;
  }

  async #runOne(connection: ConnectionRow): Promise<void> {
    this.#running.add(connection.id);
    try {
      const outcome = await this.deps.runner.run(connection.id);
      await this.#record(connection, outcome);
      // After every run, so clients showing the connection (its last run, next run and counts)
      // refresh even when its state did not change.
      await this.deps.connections.announceRun(connection.id, outcome.ok);
    } finally {
      this.#running.delete(connection.id);
    }
  }

  async #record(connection: ConnectionRow, outcome: RunOutcome): Promise<void> {
    const now = this.deps.clock.now();
    if (outcome.ok) {
      this.deps.onRunSucceeded?.(connection.id, outcome.liveTargets);
      const next = nextRunAfterSuccess({
        now,
        timeZone: this.deps.timeZone,
        quietWindow: this.deps.quietWindow ?? true,
        kind: connection.kind,
        staggerMinutes: staggerMinutes(`${this.deps.installId}:${connection.id}`),
        active: await this.#activeParcels(connection.id),
        fixedIntervalMs: this.deps.pollIntervalOf?.(connection.provider) ?? null,
      });
      await this.deps.db
        .updateTable("connections")
        .set({
          consecutive_failures: 0,
          backoff_until: null,
          next_run_at: next?.toISOString() ?? null,
          last_run_at: now.toISOString(),
          // A run that deliberately did nothing is no success to report.
          ...(outcome.idle === undefined ? { last_ok_at: now.toISOString() } : {}),
        })
        .where("id", "=", connection.id)
        .execute();
      const state = outcome.idle === undefined ? "ok" : "idle";
      const detail = outcome.idle ?? null;
      if (connection.state !== state || connection.state_detail !== detail) {
        await this.deps.connections.setState(connection.id, state, detail);
      }
      return;
    }
    const failures = connection.consecutive_failures + 1;
    const delay = delayAfterFailure(outcome.kind, failures, outcome.retryAfterSeconds);
    const next = delay === null ? null : new Date(now.getTime() + delay).toISOString();
    await this.deps.db
      .updateTable("connections")
      .set({
        consecutive_failures: failures,
        // A wait the carrier imposed (its 429, a captcha) binds manual syncs too; our own retry
        // delay after a network error does not, so the user can always try again by hand.
        backoff_until: outcome.kind === "rate_limited" || outcome.kind === "captcha" ? next : null,
        next_run_at: next,
        last_run_at: now.toISOString(),
      })
      .where("id", "=", connection.id)
      .execute();
    await this.deps.connections.setState(
      connection.id,
      outcome.kind === "sign_in_rejected" ? "needs_sign_in" : "error",
      outcome.detail,
    );
  }

  async #activeParcels(connectionId: string): Promise<ActiveParcel[]> {
    const rows = await this.deps.db
      .selectFrom("parcel_connections")
      .innerJoin("parcels", "parcels.id", "parcel_connections.parcel_id")
      .select(["parcels.status", "parcels.expected_from"])
      .where("parcel_connections.connection_id", "=", connectionId)
      .where("parcels.delivered", "=", 0)
      .where((eb) =>
        eb.or([
          eb("parcels.manual_status", "is", null),
          eb("parcels.manual_status", "!=", "delivered"),
        ]),
      )
      .where("parcels.archived_at", "is", null)
      .where("parcels.removed_at", "is", null)
      .execute();
    return rows.map((row) => ({
      status: statusOrUnknown(row.status),
      expectedFrom: row.expected_from,
    }));
  }
}
