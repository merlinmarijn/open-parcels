/**
 * The sandbox's child runtime (`docs/provider-manifest-and-sandbox.md` §2). The host starts it with
 * the Node permission model: it may read only itself and its guest module, and has no network, no
 * file writes, no child processes and no workers. Everything else goes through the host.
 *
 * This file imports nothing and uses only erasable TypeScript, so Node runs it as it is (tests)
 * and as compiled JavaScript (the image), and the protocol below is all a guest ever sees.
 *
 * Usage: node --permission … child.js <guest module path>
 */

/** An error as it crosses the process boundary; the host rebuilds the provider API's classes. */
export interface WireError {
  readonly name: string;
  readonly message: string;
  /** For a rate limit: the seconds the other side asked to wait. */
  readonly retryAfterSeconds?: number;
  /**
   * The class to rebuild when `name` is a subclass the other side does not know (a provider's own
   * error class): its nearest known ancestor, set by the guest.
   */
  readonly kind?: string;
  /** An error's own `reason` and `values` (the engine's settings errors), when it has them. */
  readonly reason?: string;
  readonly values?: Readonly<Record<string, string>>;
}

/** The fields of `error` a `WireError` keeps besides name and message, when they have the right shape. */
export function wireExtras(error: object): Omit<WireError, "name" | "message"> {
  const { retryAfterSeconds, kind, reason, values } = error as Record<string, unknown>;
  const stringRecord =
    values !== null &&
    typeof values === "object" &&
    Object.values(values).every((value) => typeof value === "string");
  return {
    ...(typeof retryAfterSeconds === "number" ? { retryAfterSeconds } : {}),
    ...(typeof kind === "string" ? { kind } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
    ...(stringRecord ? { values: values as Readonly<Record<string, string>> } : {}),
  };
}

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: WireError };

/** Host → child: run a method; or the answer to a capability request. */
export type HostMessage =
  | { readonly type: "call"; readonly id: number; readonly method: string; readonly args: unknown }
  | ({ readonly type: "reply"; readonly id: number } & Outcome);

/** Child → host: ready to take calls; a call's outcome; or a capability request from a call. */
export type ChildMessage =
  | { readonly type: "ready" }
  | ({ readonly type: "result"; readonly id: number } & Outcome)
  | {
      readonly type: "request";
      readonly id: number;
      /** The call the request belongs to: the host answers only while that call runs. */
      readonly call: number;
      readonly capability: string;
      readonly args: unknown;
    };

/** What a guest method gets besides its arguments: the capabilities the host granted this call. */
export interface Broker {
  request(capability: string, args: unknown): Promise<unknown>;
}

/** A guest module's default export: its methods by name. */
export type GuestMethods = Readonly<
  Record<string, (args: unknown, broker: Broker) => Promise<unknown>>
>;

/** An error as `WireError`: its name, its message and the extras above, nothing else. */
function toWire(error: unknown): WireError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  return { name: error.name, message: error.message, ...wireExtras(error) };
}

function send(message: ChildMessage): void {
  process.send?.(message);
}

async function main(guestPath: string): Promise<void> {
  const loaded = (await import(guestPath)) as { default?: GuestMethods };
  const guest = loaded.default ?? {};
  let nextRequest = 1;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  const brokerFor = (call: number): Broker => ({
    request(capability, args) {
      const id = nextRequest++;
      send({ type: "request", id, call, capability, args });
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
      });
    },
  });

  const run = async (id: number, method: string, args: unknown): Promise<void> => {
    try {
      // Own methods only: "constructor" or "toString" are never callable from the host.
      const fn = Object.hasOwn(guest, method) ? guest[method] : undefined;
      if (typeof fn !== "function") {
        throw new Error(`The guest has no method ${method}.`);
      }
      send({ type: "result", id, ok: true, value: await fn(args, brokerFor(id)) });
    } catch (error) {
      send({ type: "result", id, ok: false, error: toWire(error) });
    }
  };

  process.on("message", (message: HostMessage) => {
    if (message.type === "call") {
      void run(message.id, message.method, message.args);
      return;
    }
    const pending = waiting.get(message.id);
    waiting.delete(message.id);
    if (pending === undefined) return;
    if (message.ok) {
      pending.resolve(message.value);
    } else {
      pending.reject(Object.assign(new Error(message.error.message), message.error));
    }
  });
  // The host's end of the channel is the only thing keeping this process alive.
  process.on("disconnect", () => process.exit(0));
  send({ type: "ready" });
}

// Only as the process's entry point: the host imports this file for its types and `wireExtras`.
const guestPath = process.argv[2];
if (import.meta.main && guestPath !== undefined && process.send !== undefined) {
  void main(guestPath);
}
