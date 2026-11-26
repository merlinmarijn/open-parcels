import { BUILTIN_CARRIERS } from "../engine/builtin-carriers.js";
import type { BaseContext, RegisteredProvider } from "../engine/registry.js";
import type { Clock } from "../clock.js";
import { ProviderHttp } from "../provider/http.js";
import type { ProviderLogger } from "../provider/api.js";
import type { Broker, GuestMethods } from "./child.js";
import { brokeredTransport } from "./http.js";
import {
  CAPABILITY,
  rebuildProviderError,
  withKind,
  type ActionWireCall,
  type CallBase,
  type ConnectionCall,
  type JobAnswer,
  type LiveCall,
  type LogRequest,
  type SignInTurnCall,
  type TrackCall,
  type UnknownRequest,
} from "./provider-wire.js";

/**
 * The provider guest (`docs/provider-manifest-and-sandbox.md` §2): the built-in carriers, served
 * from the sandbox child. Each call brings its config, secret and session, and reaches the core
 * only through the capabilities the call was granted: every HTTP hop, session saves, log lines and
 * unknown values. The registry runs here as in the core, so config and secret are validated by the
 * same code in both isolation modes.
 */

const providers = new Map(BUILTIN_CARRIERS.map((provider) => [provider.info.id, provider]));

function providerOf(id: string): RegisteredProvider {
  const provider = providers.get(id);
  if (provider === undefined) {
    throw new Error(`The sandbox has no provider ${id}.`);
  }
  return provider;
}

/** Sends a request whose answer nobody waits for (a log line); a refusal is dropped. */
function tell(broker: Broker, capability: string, args: unknown): void {
  try {
    broker.request(capability, args).catch(() => undefined);
  } catch {
    // A value that cannot cross the boundary (a function in a log context): the line is dropped.
  }
}

/**
 * The call's view of the core: a clock that holds the core's time, moved on by every answered hop
 * (a fake clock in tests advances as the core's pacing waits), and a broker whose refusals come
 * back as the provider API's error classes.
 */
function connect(call: CallBase, broker: Broker): { clock: Clock; http: ProviderHttp } {
  let now = call.now;
  const clock: Clock = { now: () => new Date(now) };
  const rebuilding: Broker = {
    async request(capability, args) {
      try {
        const answer = await broker.request(capability, args);
        if (capability === CAPABILITY.http) {
          now = (answer as { now: number }).now;
        }
        return answer;
      } catch (error) {
        throw error instanceof Error ? rebuildProviderError(error) : error;
      }
    },
  };
  return { clock, http: new ProviderHttp(brokeredTransport(rebuilding)) };
}

function baseFor(call: ConnectionCall, broker: Broker): BaseContext {
  const { clock, http } = connect(call, broker);
  let session = call.session;
  const log =
    (level: LogRequest["level"]): ProviderLogger["warn"] =>
    (context, message) => {
      tell(broker, CAPABILITY.log, { level, context, message } satisfies LogRequest);
    };
  return {
    connectionId: call.connectionId,
    http,
    clock,
    logger: { debug: log("debug"), info: log("info"), warn: log("warn") },
    session: {
      load: () => session,
      async save(value) {
        await broker.request(CAPABILITY.sessionSave, value);
        session = value;
      },
    },
    reportUnknown: (kind, key) => {
      tell(broker, CAPABILITY.reportUnknown, { kind, key } satisfies UnknownRequest);
    },
  };
}

/** A guest method whose errors carry their known class (`withKind`) across the boundary. */
function served(method: (call: never, broker: Broker) => Promise<unknown>): GuestMethods[string] {
  return async (args, broker) => {
    try {
      return await method(args as never, broker);
    } catch (error) {
      throw withKind(error);
    }
  };
}

const methods: GuestMethods = {
  providers: () => Promise.resolve([...providers.keys()]),

  fetchAccount: served((call: ConnectionCall, broker) =>
    providerOf(call.provider).fetchAccount(baseFor(call, broker), call.rawConfig, call.rawSecret),
  ),

  track: served((call: TrackCall, broker) =>
    providerOf(call.provider).track(
      baseFor(call, broker),
      call.rawConfig,
      call.rawSecret,
      call.trackingNumbers,
    ),
  ),

  readLive: served((call: LiveCall, broker) =>
    providerOf(call.provider).readLive(
      baseFor(call, broker),
      call.rawConfig,
      call.rawSecret,
      call.target,
    ),
  ),

  runAction: served((call: ActionWireCall, broker) => {
    const controller = new AbortController();
    // Every job capability's answer says whether the job was cancelled: that aborts the signal.
    const ask = async (capability: string, args: unknown): Promise<void> => {
      const answer = (await broker.request(capability, args)) as JobAnswer;
      if (answer.cancelled) controller.abort();
    };
    let checkpoint = call.checkpoint;
    return providerOf(call.provider).runAction(
      baseFor(call, broker),
      call.rawConfig,
      call.rawSecret,
      {
        actionId: call.actionId,
        input: call.input,
        signal: controller.signal,
        checkpoint: {
          load: () => checkpoint,
          async save(value) {
            await ask(CAPABILITY.jobCheckpoint, value);
            checkpoint = value;
          },
        },
        progress(update) {
          ask(CAPABILITY.jobProgress, update).catch(() => undefined);
        },
        emit: (batch) => ask(CAPABILITY.jobEmit, batch),
      },
    );
  }),

  signInTurn: served((call: SignInTurnCall, broker) => {
    const { clock, http } = connect(call, broker);
    return providerOf(call.provider).signInTurn({
      action: call.action,
      flowId: call.flowId,
      kind: call.kind,
      rawConfig: call.rawConfig,
      http,
      clock,
      ...(call.state === undefined ? {} : { state: call.state }),
      ...(call.input === undefined ? {} : { input: call.input }),
    });
  }),
};

export default methods;
