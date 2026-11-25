import type { z } from "zod";
import type {
  CarrierProvider,
  FetchResult,
  LiveReading,
  LiveTarget,
  ProviderContext,
  ProviderConnectionKind,
  SignInFlow,
  SignInInput,
  SignInTurn,
} from "../provider/api.js";
import type { Clock } from "../clock.js";
import { InvalidConfigError } from "../provider/errors.js";
import type { HttpPolicy, ProviderHttp } from "../provider/http.js";
import { fileUnderTracked } from "./tracked.js";

export class InvalidConnectionConfigError extends Error {
  override readonly name = "InvalidConnectionConfigError";

  constructor(
    message: string,
    /** Which check failed, for the client's own text; `provider` carries the provider's words in `detail`. */
    readonly reason: InvalidConnectionReason,
    readonly values: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}

export type InvalidConnectionReason =
  | "inbox_kind"
  | "inbox_fields"
  | "unknown_provider"
  | "no_such_kind"
  | "secret_mismatch"
  | "invalid_fields"
  | "no_such_sign_in"
  | "no_tracking_provider"
  | "provider";

/** Everything a connection needs to call a provider, before config and secret are validated. */
export type BaseContext = Omit<ProviderContext<unknown, unknown>, "config" | "secret">;

export interface SignInFlowInfo {
  readonly id: string;
  readonly label: string;
  readonly type: "none" | "credentials" | "api_key" | "interactive";
  /** Connection kinds the flow applies to; all of the provider's kinds when not restricted. */
  readonly kinds: readonly ProviderConnectionKind[];
  /** True when the flow only applies to some configurations. */
  readonly conditional: boolean;
  /** What the user fills in for a credentials or API-key flow; null means the provider's schema. */
  readonly fields: z.ZodType | null;
}

/** One call into an interactive flow: `start` (no state), `continue` (with input) or `poll`. */
export interface SignInCall {
  readonly action: "start" | "continue" | "poll";
  readonly flowId: string;
  readonly kind: ProviderConnectionKind;
  readonly rawConfig: unknown;
  readonly http: ProviderHttp;
  readonly clock: Clock;
  readonly state?: unknown;
  readonly input?: SignInInput;
}

/** Public description of a provider for the API and the UI. */
export interface ProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly countries: readonly string[];
  readonly connectionKinds: readonly ProviderConnectionKind[];
  /** Type of the default flow (`none`, `credentials`, `api_key` or `interactive`). */
  readonly signIn: string;
  readonly signInFlows: readonly SignInFlowInfo[];
  readonly configSchema: z.ZodType;
  readonly secretSchema: z.ZodType;
  /** Hosts the image proxy may fetch this carrier's pictures from (see `CarrierProvider`). */
  readonly imageHosts: readonly string[];
  /** Fixed time between runs, or null for the adaptive schedule (see `CarrierProvider`). */
  readonly pollIntervalMs: number | null;
  /** A fallback tracking service, not a carrier (see `CarrierProvider`). */
  readonly fallback: boolean;
}

/**
 * A provider with its generic parameters erased. Config and secret arrive as stored JSON and are
 * validated against the provider's own schemas before the typed functions are called, so the
 * registry can hold providers of different types without casts.
 */
export interface RegisteredProvider {
  readonly info: ProviderInfo;
  readonly http: HttpPolicy;
  readonly canFetchAccount: boolean;
  readonly canTrack: boolean;
  readonly canReadLive: boolean;
  /** Checks a configuration and returns it parsed, with the provider's defaults applied. */
  validateConfig(raw: unknown): unknown;
  /** The sign-in flows that apply to a connection of this kind and configuration, default first. */
  signInFlows(kind: ProviderConnectionKind, rawConfig: unknown): SignInFlowInfo[];
  /** Runs one call of an interactive flow. A finished sign-in's secret is already validated. */
  signInTurn(call: SignInCall): Promise<SignInTurn<unknown>>;
  readLive(
    base: BaseContext,
    rawConfig: unknown,
    rawSecret: unknown,
    target: LiveTarget,
  ): Promise<LiveReading | null>;
  fetchAccount(base: BaseContext, rawConfig: unknown, rawSecret: unknown): Promise<FetchResult>;
  track(
    base: BaseContext,
    rawConfig: unknown,
    rawSecret: unknown,
    trackingNumbers: readonly string[],
  ): Promise<FetchResult>;
}

/** A provider's settings error, as the engine's own, so the connection shows it as invalid settings. */
async function asConnectionConfigError<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof InvalidConfigError) {
      throw new InvalidConnectionConfigError(error.message, "provider", { detail: error.message });
    }
    throw error;
  }
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, what: string, providerId: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new InvalidConnectionConfigError(
      `The ${what} for ${providerId} is invalid at: ${paths}.`,
      "invalid_fields",
      { provider: providerId, fields: paths },
    );
  }
  return parsed.data;
}

function flowInfo<Config, Secret>(
  provider: CarrierProvider<Config, Secret>,
  flow: SignInFlow<Config, Secret>,
): SignInFlowInfo {
  return {
    id: flow.id ?? flow.type,
    label: flow.label ?? flow.type,
    type: flow.type,
    kinds: flow.kinds ?? provider.connectionKinds,
    conditional: flow.when !== undefined,
    fields: flow.type === "interactive" ? null : (flow.fields ?? null),
  };
}

function flowsOf<Config, Secret>(
  provider: CarrierProvider<Config, Secret>,
): readonly SignInFlow<Config, Secret>[] {
  const flows: readonly SignInFlow<Config, Secret>[] = Array.isArray(provider.signIn)
    ? provider.signIn
    : [provider.signIn as SignInFlow<Config, Secret>];
  const ids = new Set<string>();
  for (const flow of flows) {
    const id = flow.id ?? flow.type;
    if (ids.has(id)) {
      throw new Error(`Two sign-in flows of ${provider.id} share the id ${id}.`);
    }
    ids.add(id);
  }
  return flows;
}

function applies<Config, Secret>(
  flow: SignInFlow<Config, Secret>,
  kind: ProviderConnectionKind,
  config: Config,
): boolean {
  return (flow.kinds?.includes(kind) ?? true) && (flow.when?.(config) ?? true);
}

/** The interactive half of `register`: picks the flow and validates what it finishes with. */
async function runSignIn<Config, Secret>(
  provider: CarrierProvider<Config, Secret>,
  flows: readonly SignInFlow<Config, Secret>[],
  call: SignInCall,
): Promise<SignInTurn<unknown>> {
  const config = parseWith(provider.configSchema, call.rawConfig, "configuration", provider.id);
  const flow = flows.find((candidate) => (candidate.id ?? candidate.type) === call.flowId);
  if (flow?.type !== "interactive" || !applies(flow, call.kind, config)) {
    throw new InvalidConnectionConfigError(
      `${provider.name} has no interactive sign-in "${call.flowId}" for this connection.`,
      "no_such_sign_in",
      { provider: provider.name },
    );
  }
  const context = { config, kind: call.kind, http: call.http, clock: call.clock };
  let turn: SignInTurn<Secret>;
  if (call.action === "start") {
    turn = await flow.start(context);
  } else if (call.action === "continue") {
    turn = await flow.continue(context, call.state, call.input ?? {});
  } else {
    if (flow.poll === undefined) {
      throw new InvalidConnectionConfigError(
        `${provider.name}'s sign-in has nothing to wait for.`,
        "no_such_sign_in",
        { provider: provider.name },
      );
    }
    turn = await flow.poll(context, call.state);
  }
  if ("secret" in turn) {
    return { secret: parseWith(provider.secretSchema, turn.secret, "sign-in data", provider.id) };
  }
  return turn;
}

export function register<Config, Secret>(
  provider: CarrierProvider<Config, Secret>,
): RegisteredProvider {
  const flows = flowsOf(provider);
  const context = (
    base: BaseContext,
    rawConfig: unknown,
    rawSecret: unknown,
  ): ProviderContext<Config, Secret> => ({
    ...base,
    config: parseWith(provider.configSchema, rawConfig, "configuration", provider.id),
    secret: parseWith(provider.secretSchema, rawSecret, "sign-in data", provider.id),
  });
  return {
    info: {
      id: provider.id,
      name: provider.name,
      countries: provider.countries,
      connectionKinds: provider.connectionKinds,
      signIn: flows[0]?.type ?? "none",
      signInFlows: flows.map((flow) => flowInfo(provider, flow)),
      configSchema: provider.configSchema,
      secretSchema: provider.secretSchema,
      imageHosts: provider.imageHosts ?? [],
      pollIntervalMs: provider.pollIntervalMs ?? null,
      fallback: provider.fallback === true,
    },
    http: provider.http,
    canFetchAccount: provider.fetchAccount !== undefined,
    canTrack: provider.track !== undefined,
    canReadLive: provider.readLive !== undefined,
    signInFlows(kind, rawConfig) {
      const config = parseWith(provider.configSchema, rawConfig, "configuration", provider.id);
      return flows
        .filter((flow) => applies(flow, kind, config))
        .map((flow) => flowInfo(provider, flow));
    },
    signInTurn: (call) => runSignIn(provider, flows, call),
    async readLive(base, rawConfig, rawSecret, target) {
      if (provider.readLive === undefined) {
        return null;
      }
      return provider.readLive(context(base, rawConfig, rawSecret), target);
    },
    validateConfig(raw) {
      return parseWith(provider.configSchema, raw, "configuration", provider.id);
    },
    async fetchAccount(base, rawConfig, rawSecret) {
      if (provider.fetchAccount === undefined) {
        throw new InvalidConnectionConfigError(
          `${provider.name} has no account connection.`,
          "no_such_kind",
          { provider: provider.name, kind: "account" },
        );
      }
      return asConnectionConfigError(provider.fetchAccount(context(base, rawConfig, rawSecret)));
    },
    async track(base, rawConfig, rawSecret, trackingNumbers) {
      if (provider.track === undefined) {
        throw new InvalidConnectionConfigError(
          `${provider.name} cannot track codes.`,
          "no_such_kind",
          { provider: provider.name, kind: "tracking" },
        );
      }
      const result = await asConnectionConfigError(
        provider.track(context(base, rawConfig, rawSecret), trackingNumbers),
      );
      return fileUnderTracked(provider.id, trackingNumbers, result, base.logger);
    },
  };
}

export class ProviderRegistry {
  readonly #providers = new Map<string, RegisteredProvider>();

  constructor(providers: readonly RegisteredProvider[]) {
    for (const provider of providers) {
      if (this.#providers.has(provider.info.id)) {
        throw new Error(`Two carrier providers share the id ${provider.info.id}.`);
      }
      this.#providers.set(provider.info.id, provider);
    }
  }

  get(id: string): RegisteredProvider | undefined {
    return this.#providers.get(id);
  }

  list(): RegisteredProvider[] {
    return [...this.#providers.values()].sort((a, b) => a.info.name.localeCompare(b.info.name));
  }
}
