import type { Clock } from "../clock.js";

/** Addresses remembered at most; beyond this the expired ones go, then the oldest. */
const MAX_TRACKED_ADDRESSES = 10_000;

/**
 * Limits failed login attempts per client address to slow down password guessing. Addresses are
 * forgotten once their failures expire, so many one-off addresses cannot grow it without bound.
 */
export class LoginThrottle {
  readonly #failures = new Map<string, number[]>();

  constructor(
    private readonly clock: Clock,
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly maxAddresses = MAX_TRACKED_ADDRESSES,
  ) {}

  /** How many addresses are remembered (for tests and diagnostics). */
  get size(): number {
    return this.#failures.size;
  }

  #sweep(): void {
    const cutoff = this.clock.now().getTime() - this.windowMs;
    for (const [key, times] of this.#failures) {
      if (times.every((at) => at <= cutoff)) this.#failures.delete(key);
    }
    // Still full of live entries: the oldest addresses (first inserted) make room.
    for (const key of this.#failures.keys()) {
      if (this.#failures.size < this.maxAddresses) break;
      this.#failures.delete(key);
    }
  }

  #recent(key: string): number[] {
    const cutoff = this.clock.now().getTime() - this.windowMs;
    const recent = (this.#failures.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length === 0) {
      this.#failures.delete(key);
    } else {
      this.#failures.set(key, recent);
    }
    return recent;
  }

  /** Seconds until another attempt is allowed, or 0 when allowed now. */
  retryAfterSeconds(key: string): number {
    const recent = this.#recent(key);
    if (recent.length < this.maxFailures) {
      return 0;
    }
    const oldest = recent[0] ?? this.clock.now().getTime();
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.clock.now().getTime()) / 1000));
  }

  recordFailure(key: string): void {
    const times = [...this.#recent(key), this.clock.now().getTime()];
    if (!this.#failures.has(key) && this.#failures.size >= this.maxAddresses) {
      this.#sweep();
    }
    this.#failures.set(key, times);
  }

  reset(key: string): void {
    this.#failures.delete(key);
  }
}
