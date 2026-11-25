/** Injected time source, so scheduling and expiry logic can be tested with a fake clock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Sleep that tests can replace; the scheduler's fake clock does not advance real timers. */
export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
