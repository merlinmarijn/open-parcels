/**
 * One holder at a time per key. Used per connection, so a run, a live read and each sign-in step of
 * one account never talk to the carrier at the same time; single-use refresh tokens would
 * otherwise race. Not re-entrant: a holder must never ask for its own key again.
 */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await work();
    } finally {
      release();
    }
  }

  /**
   * Waits for the key and holds it until the returned function is called (once; later calls do
   * nothing). For a holder that gives the key up and takes it again between steps (a job between
   * pages), so whoever queued meanwhile goes first.
   */
  async acquire(key: string): Promise<() => void> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.#tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    };
  }

  /** Whether anyone holds or waits for the key; for tests and diagnostics. */
  busy(key: string): boolean {
    return this.#tails.has(key);
  }
}
