import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUILTIN_CARRIERS } from "../engine/builtin-carriers.js";
import type { BaseContext, RegisteredProvider } from "../engine/registry.js";
import type { Clock } from "../clock.js";
import type {
  ActionBatch,
  ActionResult,
  FetchResult,
  JobProgress,
  LiveReading,
} from "../provider/api.js";
import type { SignInTurn } from "../provider/sign-in.js";
import type { ProviderHttp } from "../provider/http.js";
import { Sandbox, type Capability, type CallOptions } from "./host.js";
import { httpCapability } from "./http.js";
import {
  CAPABILITY,
  rebuildProviderError,
  type ActionWireCall,
  type ConnectionCall,
  type JobAnswer,
  type LiveCall,
  type LogRequest,
  type SignInTurnCall,
  type TrackCall,
  type UnknownRequest,
} from "./provider-wire.js";

/** A connection run may page through a large account at the carriers' pace. */
const RUN_TIMEOUT_MS = 10 * 60_000;
/** A live read or one sign-in turn is a handful of requests. */
const TURN_TIMEOUT_MS = 2 * 60_000;
/** A job's leg ends at its 12 h ceiling (the job service aborts it); a minute more to return. */
const ACTION_TIMEOUT_MS = 12 * 60 * 60_000 + 60_000;
/** Heap of the pool child: every built-in provider, a few connections' results at a time. */
const POOL_MEMORY_MB = 256;

/** The compiled runtime and guest: `dist/sandbox/` in the image, next to `package.json`'s `dist/`. */
interface SandboxFiles {
  readonly child: URL;
  readonly guest: URL;
  /** Everything else the guest reads: its chunks and the rules' bundle (`dist/`), `package.json`. */
  readonly readable: readonly string[];
}

/** The sandbox files of a built `dist/` folder (the image's `server/dist`). */
export function sandboxFilesIn(dist: string): SandboxFiles {
  const root = path.resolve(dist);
  return {
    child: pathToFileURL(path.join(root, "sandbox", "child.js")),
    guest: pathToFileURL(path.join(root, "sandbox", "provider-guest.js")),
    readable: [root, path.join(path.dirname(root), "package.json")],
  };
}

/**
 * Starts the one sandbox all built-in providers share in `pool` mode, and checks that its guest
 * serves exactly `expected` (the core's built-in providers): a child that cannot start under the
 * permission model, or a guest built from other code, stops the server from starting.
 */
async function startProviderPool(
  files: SandboxFiles,
  clock: Clock,
  expected: readonly string[],
): Promise<Sandbox> {
  for (const file of [files.child, files.guest]) {
    if (!existsSync(fileURLToPath(file))) {
      throw new Error(
        `Provider isolation "pool" needs the built server; ${fileURLToPath(file)} is missing.`,
      );
    }
  }
  const sandbox = new Sandbox({
    child: files.child,
    guest: files.guest,
    readable: files.readable,
    memoryMb: POOL_MEMORY_MB,
    clock,
    rebuildError: rebuildProviderError,
  });
  const served = (await sandbox.call("providers", null, {
    capabilities: {},
    timeoutMs: TURN_TIMEOUT_MS,
  })) as string[];
  const missing = expected.filter((id) => !served.includes(id));
  if (missing.length > 0 || served.length !== expected.length) {
    sandbox.stop();
    throw new Error(
      `The provider sandbox serves other providers than the server (missing: ${missing.join(", ") || "none"}).`,
    );
  }
  return sandbox;
}

/** The `http` capability: one hop through the core's transport, answered with the core's time. */
function hops(http: ProviderHttp, clock: Clock): Capability {
  const send = httpCapability(http.transport);
  return async (args) => {
    const response = (await send(args)) as object;
    return { ...response, now: clock.now().getTime() };
  };
}

/** What a connection call may use: the network, its session (if allowed), the log, reporting. */
function connectionCapabilities(
  provider: RegisteredProvider,
  base: BaseContext,
  timeoutMs: number,
): CallOptions {
  const capabilities: Record<string, Capability> = {
    [CAPABILITY.http]: hops(base.http, base.clock),
    [CAPABILITY.log]: (args) => {
      const { level, context, message } = args as LogRequest;
      base.logger[level](context, message);
      return Promise.resolve(null);
    },
    [CAPABILITY.reportUnknown]: (args) => {
      const { kind, key } = args as UnknownRequest;
      base.reportUnknown(kind, key);
      return Promise.resolve(null);
    },
  };
  if (provider.manifest.permissions.session) {
    capabilities[CAPABILITY.sessionSave] = async (value) => {
      await base.session.save(value);
      return null;
    };
  }
  return { capabilities, timeoutMs };
}

function connectionCall(
  provider: RegisteredProvider,
  base: BaseContext,
  rawConfig: unknown,
  rawSecret: unknown,
): ConnectionCall {
  return {
    provider: provider.info.id,
    connectionId: base.connectionId,
    now: base.clock.now().getTime(),
    rawConfig,
    rawSecret,
    session: provider.manifest.permissions.session ? base.session.load() : null,
  };
}

/**
 * `provider` with its behaviour served from `sandbox`: connection runs, live reads and sign-in
 * turns go to the guest's copy of the same provider; what it is (info, manifest, schemas, flows)
 * is answered here, without a call.
 */
export function isolated(provider: RegisteredProvider, sandbox: Sandbox): RegisteredProvider {
  return {
    ...provider,
    async fetchAccount(base, rawConfig, rawSecret) {
      const call = connectionCall(provider, base, rawConfig, rawSecret);
      const options = connectionCapabilities(provider, base, RUN_TIMEOUT_MS);
      return (await sandbox.call("fetchAccount", call, options)) as FetchResult;
    },
    async track(base, rawConfig, rawSecret, trackingNumbers) {
      const call: TrackCall = {
        ...connectionCall(provider, base, rawConfig, rawSecret),
        trackingNumbers,
      };
      const options = connectionCapabilities(provider, base, RUN_TIMEOUT_MS);
      return (await sandbox.call("track", call, options)) as FetchResult;
    },
    async readLive(base, rawConfig, rawSecret, target) {
      const call: LiveCall = { ...connectionCall(provider, base, rawConfig, rawSecret), target };
      const options = connectionCapabilities(provider, base, TURN_TIMEOUT_MS);
      return (await sandbox.call("readLive", call, options)) as LiveReading | null;
    },
    async runAction(base, rawConfig, rawSecret, job) {
      const call: ActionWireCall = {
        ...connectionCall(provider, base, rawConfig, rawSecret),
        actionId: job.actionId,
        input: job.input,
        checkpoint: job.checkpoint.load(),
      };
      const answer = (): JobAnswer => ({ cancelled: job.signal.aborted });
      const options = connectionCapabilities(provider, base, ACTION_TIMEOUT_MS);
      const capabilities: Record<string, Capability> = {
        ...options.capabilities,
        [CAPABILITY.jobProgress]: (args) => {
          job.progress(args as JobProgress);
          return Promise.resolve(answer());
        },
        [CAPABILITY.jobEmit]: async (args) => {
          await job.emit(args as ActionBatch);
          return answer();
        },
        [CAPABILITY.jobCheckpoint]: async (args) => {
          await job.checkpoint.save(args);
          return answer();
        },
      };
      return (await sandbox.call("runAction", call, {
        capabilities,
        timeoutMs: ACTION_TIMEOUT_MS,
      })) as ActionResult;
    },
    async signInTurn(turn) {
      const call: SignInTurnCall = {
        provider: provider.info.id,
        connectionId: "",
        now: turn.clock.now().getTime(),
        action: turn.action,
        flowId: turn.flowId,
        kind: turn.kind,
        rawConfig: turn.rawConfig,
        ...(turn.state === undefined ? {} : { state: turn.state }),
        ...(turn.input === undefined ? {} : { input: turn.input }),
      };
      const options: CallOptions = {
        capabilities: { [CAPABILITY.http]: hops(turn.http, turn.clock) },
        timeoutMs: TURN_TIMEOUT_MS,
      };
      const answer = (await sandbox.call("signInTurn", call, options)) as SignInTurn<unknown>;
      // The guest validated a finished sign-in's secret already; the core checks it again on its
      // own side, so a guest built from other code can never store sign-in data of another shape.
      return "secret" in answer ? { secret: provider.validateSecret(answer.secret) } : answer;
    },
  };
}

/**
 * The built-in providers as the server runs them: in-process (`off`), or served from one sandbox
 * child started here (`pool`), which the server stops when it stops.
 */
export async function builtinProviders(
  isolation: "off" | "pool",
  files: SandboxFiles,
  clock: Clock,
  logger: { info(message: string): void },
): Promise<{ providers: readonly RegisteredProvider[]; pool: Sandbox | undefined }> {
  if (isolation === "off") {
    return { providers: BUILTIN_CARRIERS, pool: undefined };
  }
  const pool = await startProviderPool(
    files,
    clock,
    BUILTIN_CARRIERS.map((provider) => provider.info.id),
  );
  logger.info("The built-in providers run in the provider sandbox (pool).");
  return { providers: BUILTIN_CARRIERS.map((provider) => isolated(provider, pool)), pool };
}
