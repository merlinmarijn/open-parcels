import type { z } from "zod";
import type {
  ActionBatch,
  ActionResult,
  CarrierProvider,
  CheckpointStore,
  EmailContext,
  EmailResult,
  JobProgress,
  FetchResult,
  LiveReading,
  LiveTarget,
  ProviderContext,
  ProviderEmail,
  ProviderConnectionKind,
  SignInFlow,
  SignInInput,
  SignInTurn,
} from "../provider/api.js";
import type { Clock } from "../clock.js";
import { InvalidConfigError } from "../provider/errors.js";
import type { HttpPolicy, ProviderHttp } from "../provider/http.js";
import {
  hostMatches,
  networkAllowList,
  type HostAllowList,
  type ProviderManifest,
  type SecretKind,
} from "../provider/manifest.js";
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

/**
 * What the job service hands a task action besides config and secret: its input (validated
 * already), and the job's side of the context (`ActionContext` without the connection's part).
 */
export interface ActionCall {
  readonly actionId: string;
  readonly input: unknown;
  readonly signal: AbortSignal;
  readonly checkpoint: CheckpointStore;
  progress(update: JobProgress): void;
  emit(batch: ActionBatch): Promise<void>;
  wait(ms: number): Promise<void>;
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
interface ProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly countries: readonly string[];
  readonly connectionKinds: readonly ProviderConnectionKind[];
  /** Other names to search for (see `CarrierProvider`). */
  readonly aliases: readonly string[];
  /** Logo file name in `logos/`, or null (see `CarrierProvider`). */
  readonly logo: string | null;
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
  /** Its actions as the manifest declares them. */
  readonly actions: ProviderManifest["actions"];
}

/**
 * A provider with its generic parameters erased. Config and secret arrive as stored JSON and are
 * validated against the provider's own schemas before the typed functions are called, so the
 * registry can hold providers of different types without casts.
 */
export interface RegisteredProvider {
  readonly info: ProviderInfo;
  readonly manifest: ProviderManifest;
  readonly http: HttpPolicy;
  /** The hosts a connection with this (stored, unvalidated) config may reach. */
  hostsFor(rawConfig: unknown): HostAllowList;
  readonly canFetchAccount: boolean;
  readonly canTrack: boolean;
  readonly canReadLive: boolean;
  /** Reads email (`parseEmail`); exactly the providers whose manifest has an `email` section. */
  readonly canParseEmail: boolean;
  /** Reads one email routed to it; a provider without `parseEmail` ignores every email. */
  parseEmail(context: EmailContext, email: ProviderEmail): Promise<EmailResult>;
  /** Checks a configuration and returns it parsed, with the provider's defaults applied. */
  validateConfig(raw: unknown): unknown;
  /** Checks sign-in data against the provider's secret schema and returns it parsed. */
  validateSecret(raw: unknown): unknown;
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
  /** A task action's input schema; undefined for a link or an unknown id. */
  actionInput(actionId: string): z.ZodType | undefined;
  /** Runs one leg of a task action (`docs/connection-actions-and-jobs.md` §2). */
  runAction(
    base: BaseContext,
    rawConfig: unknown,
    rawSecret: unknown,
    call: ActionCall,
  ): Promise<ActionResult>;
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

/** Labels of the flows a provider leaves unnamed (texts the server translates, `i18n/`). */
const DEFAULT_FLOW_LABELS: Readonly<Record<SignInFlow<unknown, unknown>["type"], string>> = {
  none: "No sign-in",
  credentials: "Username and password",
  api_key: "API key",
  interactive: "Sign in",
};

function flowInfo<Config, Secret>(
  manifest: ProviderManifest,
  flow: SignInFlow<Config, Secret>,
): SignInFlowInfo {
  return {
    id: flow.id ?? flow.type,
    label: flow.label ?? DEFAULT_FLOW_LABELS[flow.type],
    type: flow.type,
    kinds: flow.kinds ?? manifest.provides.connections,
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
  provider: CarrierProvider<Config, Secret> & { readonly name: string },
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

/** The secret kind each sign-in flow type stores. */
const FLOW_SECRET: Readonly<Record<SignInFlow<unknown, unknown>["type"], SecretKind | null>> = {
  none: null,
  credentials: "credentials",
  api_key: "api_key",
  interactive: "token",
};

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/**
 * Every way the code and its manifest can disagree, as one message each. Registration fails on
 * any: a built-in provider whose manifest lies never starts.
 */
function disagreements<Config, Secret>(
  provider: CarrierProvider<Config, Secret>,
  manifest: ProviderManifest,
  flows: readonly SignInFlow<Config, Secret>[],
): string[] {
  const problems: string[] = [];
  const kinds = manifest.provides.connections;
  if (provider.id !== manifest.id) problems.push(`the code's id is ${provider.id}`);
  if (kinds.some((kind) => kind !== "tracking") !== (provider.fetchAccount !== undefined)) {
    problems.push("account/shop connections and fetchAccount must come together");
  }
  if (kinds.includes("tracking") !== (provider.track !== undefined)) {
    problems.push("tracking connections and track must come together");
  }
  if (manifest.provides.live !== (provider.readLive !== undefined)) {
    problems.push("provides.live and readLive must come together");
  }
  if ((manifest.email !== undefined) !== (provider.parseEmail !== undefined)) {
    problems.push("email and parseEmail must come together");
  }
  const secrets = flows.flatMap((flow) => FLOW_SECRET[flow.type] ?? []);
  if (!sameSet(secrets, manifest.permissions.secrets)) {
    problems.push(`permissions.secrets must be [${[...new Set(secrets)].join(", ")}]`);
  }
  if (manifest.permissions.user_agent !== (provider.http.userAgent !== undefined)) {
    problems.push("permissions.user_agent and http.userAgent must come together");
  }
  const patterns = manifest.permissions.network.flatMap((entry) =>
    "host" in entry ? [entry.host] : [],
  );
  const tasks = manifest.actions.filter((action) => action.kind === "task").map((a) => a.id);
  if (!sameSet(tasks, Object.keys(provider.actions ?? {}))) {
    problems.push(`the code's actions must be the manifest's tasks [${tasks.join(", ")}]`);
  }
  for (const action of manifest.actions) {
    if (action.connection_kinds.some((kind) => !kinds.includes(kind))) {
      problems.push(`action ${action.id} names a connection kind the provider does not offer`);
    }
  }
  for (const host of Object.keys(provider.http.limits)) {
    if (host !== "*" && !patterns.some((pattern) => hostMatches(pattern, host))) {
      problems.push(`http.limits names ${host}, which permissions.network does not allow`);
    }
  }
  return problems;
}

/** Why a provider without `permissions.session` cannot save: its store holds nothing. */
const NO_SESSION_MESSAGE = "This provider's manifest does not allow a session store.";

/**
 * Pairs a provider's code with its manifest. Throws when they disagree (see `disagreements`).
 */
export function register<Config, Secret>(
  code: CarrierProvider<Config, Secret>,
  manifest: ProviderManifest,
): RegisteredProvider {
  const provider = { ...code, name: manifest.name };
  const flows = flowsOf(provider);
  const problems = disagreements(code, manifest, flows);
  if (problems.length > 0) {
    throw new Error(
      `The manifest of ${manifest.id} does not match its code: ${problems.join("; ")}.`,
    );
  }
  const sessionAllowed = manifest.permissions.session;
  const context = (
    base: BaseContext,
    rawConfig: unknown,
    rawSecret: unknown,
  ): ProviderContext<Config, Secret> => ({
    ...base,
    session: sessionAllowed
      ? base.session
      : {
          load: () => null,
          save: () => Promise.reject(new Error(NO_SESSION_MESSAGE)),
        },
    config: parseWith(provider.configSchema, rawConfig, "configuration", provider.id),
    secret: parseWith(provider.secretSchema, rawSecret, "sign-in data", provider.id),
  });
  return {
    info: {
      id: manifest.id,
      name: manifest.name,
      countries: manifest.countries,
      connectionKinds: manifest.provides.connections,
      aliases: manifest.aliases ?? [],
      logo: manifest.logo ?? null,
      signIn: flows[0]?.type ?? "none",
      signInFlows: flows.map((flow) => flowInfo(manifest, flow)),
      configSchema: provider.configSchema,
      secretSchema: provider.secretSchema,
      imageHosts: manifest.permissions.image_hosts,
      pollIntervalMs: provider.pollIntervalMs ?? null,
      fallback: manifest.provides.fallback,
      actions: manifest.actions,
    },
    manifest,
    http: provider.http,
    hostsFor: (rawConfig) => networkAllowList(manifest, rawConfig),
    canFetchAccount: provider.fetchAccount !== undefined,
    canTrack: provider.track !== undefined,
    canReadLive: provider.readLive !== undefined,
    canParseEmail: provider.parseEmail !== undefined,
    async parseEmail(emailContext, email) {
      if (provider.parseEmail === undefined) {
        return { snapshots: [], ignored: `${provider.name} reads no email.` };
      }
      return provider.parseEmail(emailContext, email);
    },
    signInFlows(kind, rawConfig) {
      const config = parseWith(provider.configSchema, rawConfig, "configuration", provider.id);
      return flows
        .filter((flow) => applies(flow, kind, config))
        .map((flow) => flowInfo(manifest, flow));
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
    validateSecret(raw) {
      return parseWith(provider.secretSchema, raw, "sign-in data", provider.id);
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
    actionInput: (actionId) =>
      Object.hasOwn(provider.actions ?? {}, actionId)
        ? provider.actions?.[actionId]?.input
        : undefined,
    async runAction(base, rawConfig, rawSecret, call) {
      const action = Object.hasOwn(provider.actions ?? {}, call.actionId)
        ? provider.actions?.[call.actionId]
        : undefined;
      if (action === undefined) {
        throw new InvalidConnectionConfigError(
          `${provider.name} has no action ${call.actionId}.`,
          "no_such_kind",
          { provider: provider.name, kind: call.actionId },
        );
      }
      const input = parseWith(action.input, call.input, "action input", provider.id);
      return asConnectionConfigError(
        action.run(
          {
            ...context(base, rawConfig, rawSecret),
            signal: call.signal,
            checkpoint: call.checkpoint,
            progress: (update) => {
              call.progress(update);
            },
            emit: (batch) => call.emit(batch),
            wait: (ms) => call.wait(ms),
          },
          input,
        ),
      );
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
