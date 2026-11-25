import { appendEvent } from "../events/bus.js";
import type { Services } from "../services.js";
import { collectStatus } from "./service.js";

/** How often the server compares its health with the last one it announced. */
const HEALTH_WATCH_INTERVAL_MS = 30_000;

/**
 * Announces `health.changed` when the overall status, a check or an inbox's connection changes,
 * so clients (the Status page, Home Assistant) need not poll. One timer for every client.
 */
export class HealthWatch {
  #timer: ReturnType<typeof setInterval> | undefined;
  #last: string | undefined;

  constructor(private readonly services: Services) {}

  start(): void {
    if (this.#timer !== undefined) return;
    const tick = (): void => {
      this.checkOnce().catch((error: unknown) => {
        this.services.logger.warn({ err: error }, "Checking the server's health failed.");
      });
    };
    this.#timer = setInterval(tick, HEALTH_WATCH_INTERVAL_MS);
    this.#timer.unref();
    tick();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Compares once; true when it announced a change. The first check only remembers. */
  async checkOnce(): Promise<boolean> {
    const report = await collectStatus(this.services);
    const summary = {
      status: report.status,
      checks: report.checks,
      inboxes: report.inboxes.map((inbox) => ({ id: inbox.id, connected: inbox.connected })),
    };
    const key = JSON.stringify(summary);
    const previous = this.#last;
    this.#last = key;
    if (previous === undefined || previous === key) return false;
    await appendEvent(this.services.db, this.services.clock, {
      type: "health.changed",
      parcelId: null,
      payload: { status: report.status, checks: report.checks },
    });
    await this.services.bus.notify();
    return true;
  }
}
