import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "../clock.js";
import { wireExtras, type ChildMessage, type HostMessage, type WireError } from "./child.js";

/**
 * The host side of the sandbox (`docs/provider-manifest-and-sandbox.md` §2): one child process
 * under the Node permission model that runs a guest module's methods. It knows nothing about
 * providers or consumers; they bring the guest, the capabilities each call may use and the way
 * errors are rebuilt.
 */

/** A capability's handler on the host, for the duration of one call. */
export type Capability = (args: unknown) => Promise<unknown>;

export interface CallOptions {
  /** What the call may ask the host for, by name. Nothing else is answered. */
  readonly capabilities: Readonly<Record<string, Capability>>;
  /** After this long the child is killed and the call fails with `SandboxTimeoutError`. */
  readonly timeoutMs: number;
}

export interface SandboxOptions {
  /** The child runtime (`child.ts` / `child.js`). */
  readonly child: URL;
  /** The guest module; with everything under `readable`, the only files the child may read. */
  readonly guest: URL;
  /** Further files or folders the guest needs to read (its own package). */
  readonly readable?: readonly string[];
  /** Heap limit of the child, in MB. */
  readonly memoryMb: number;
  readonly clock: Clock;
  /** Rebuilds an error that crossed the boundary (the provider API's classes, say). */
  readonly rebuildError: (wire: WireError) => Error;
}

/** The child did not answer in time; it was stopped and starts again with the next call. */
export class SandboxTimeoutError extends Error {
  override readonly name = "SandboxTimeoutError";
}

/** The child ended while the call ran (a crash, or the heap limit). */
export class SandboxCrashedError extends Error {
  override readonly name = "SandboxCrashedError";
}

/** The child crashed too often; calls fail until `enable()`. */
export class SandboxDisabledError extends Error {
  override readonly name = "SandboxDisabledError";
}

/** This Node cannot confine a child's network: the core refuses to start sandboxes on it. */
class SandboxUnsupportedError extends Error {
  override readonly name = "SandboxUnsupportedError";
}

const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 10 * 60_000;
/** How long a new child may take to load its guest and say it is ready. */
const START_TIMEOUT_MS = 10_000;

/** True when this Node's permission model also governs the network (`--allow-net` exists). */
function permissionModelConfinesNetwork(): boolean {
  return process.allowedNodeEnvironmentFlags.has("--allow-net");
}

interface Pending {
  readonly capabilities: Readonly<Record<string, Capability>>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class Sandbox {
  #child: ChildProcess | undefined;
  #ready: Promise<ChildProcess> | undefined;
  #nextCall = 1;
  readonly #pending = new Map<number, Pending>();
  #crashes: number[] = [];
  #disabled = false;

  constructor(private readonly options: SandboxOptions) {}

  /** Runs `method` of the guest with `args`; `options.capabilities` answer its requests. */
  async call(method: string, args: unknown, options: CallOptions): Promise<unknown> {
    if (this.#disabled) {
      throw new SandboxDisabledError("The sandbox crashed too often and is switched off.");
    }
    const child = await this.#start();
    const id = this.#nextCall++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settle(id, new SandboxTimeoutError(`The sandbox did not finish ${method} in time.`));
        // Whatever it was doing is abandoned with it; the next call starts a fresh child.
        this.#kill();
      }, options.timeoutMs);
      this.#pending.set(id, { capabilities: options.capabilities, resolve, reject, timer });
      const message: HostMessage = { type: "call", id, method, args };
      child.send(message);
    });
  }

  /** Switches a sandbox that crashed too often back on. */
  enable(): void {
    this.#disabled = false;
    this.#crashes = [];
  }

  /** Stops the child; the next call starts a new one. */
  stop(): void {
    this.#kill();
  }

  #start(): Promise<ChildProcess> {
    this.#ready ??= this.#spawn().catch((error: unknown) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  #spawn(): Promise<ChildProcess> {
    if (!permissionModelConfinesNetwork()) {
      throw new SandboxUnsupportedError(
        `Node ${process.version} cannot keep a sandbox off the network; update Node.`,
      );
    }
    const readable = [
      fileURLToPath(this.options.child),
      fileURLToPath(this.options.guest),
      ...(this.options.readable ?? []).map((entry) => path.resolve(entry)),
    ];
    const child = fork(fileURLToPath(this.options.child), [fileURLToPath(this.options.guest)], {
      execArgv: [
        "--permission",
        ...readable.map((entry) => `--allow-fs-read=${entry}`),
        `--max-old-space-size=${String(this.options.memoryMb)}`,
        "--disallow-code-generation-from-strings",
      ],
      // Nothing but the IPC channel: no inherited output, no environment with secrets in it.
      env: {},
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.#child = child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SandboxTimeoutError("The sandbox did not start in time."));
        this.#kill();
      }, START_TIMEOUT_MS);
      child.on("message", (message: ChildMessage) => {
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve(child);
          return;
        }
        this.#onMessage(child, message);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new SandboxCrashedError("The sandbox ended before it was ready."));
        this.#onExit(child);
      });
    });
  }

  #onMessage(child: ChildProcess, message: Exclude<ChildMessage, { type: "ready" }>): void {
    if (message.type === "result") {
      this.#settle(
        message.id,
        message.ok ? undefined : this.options.rebuildError(message.error),
        message.ok ? message.value : undefined,
      );
      return;
    }
    const capability = this.#pending.get(message.call)?.capabilities[message.capability];
    const answer =
      capability === undefined
        ? Promise.reject(new Error(`This call may not use ${message.capability}.`))
        : capability(message.args);
    void answer.then(
      (value) => {
        this.#reply(child, { type: "reply", id: message.id, ok: true, value });
      },
      (error: unknown) => {
        this.#reply(child, { type: "reply", id: message.id, ok: false, error: wireOf(error) });
      },
    );
  }

  #reply(child: ChildProcess, message: HostMessage): void {
    if (child === this.#child && child.connected) {
      child.send(message);
    }
  }

  #onExit(child: ChildProcess): void {
    // A child killed on purpose was forgotten already (`#kill`).
    if (child !== this.#child) return;
    this.#child = undefined;
    this.#ready = undefined;
    for (const id of [...this.#pending.keys()]) {
      this.#settle(id, new SandboxCrashedError("The sandbox ended during the call."));
    }
    const now = this.options.clock.now().getTime();
    this.#crashes = [...this.#crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    if (this.#crashes.length >= CRASH_LIMIT) {
      this.#disabled = true;
    }
  }

  #settle(id: number, error: Error | undefined, value?: unknown): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (error === undefined) {
      pending.resolve(value);
    } else {
      pending.reject(error);
    }
  }

  /**
   * Kills the child at once and forgets it, so the next call starts a new one even before the
   * old one's exit arrives; calls still running in it fail as crashed. Never counts as a crash.
   */
  #kill(): void {
    const child = this.#child;
    if (child === undefined) return;
    this.#child = undefined;
    this.#ready = undefined;
    child.kill("SIGKILL");
    for (const id of [...this.#pending.keys()]) {
      this.#settle(id, new SandboxCrashedError("The sandbox was stopped during the call."));
    }
  }
}

/** A host-side error for the child: name, message and the extras `WireError` keeps. */
function wireOf(error: unknown): WireError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  return { name: error.name, message: error.message, ...wireExtras(error) };
}
