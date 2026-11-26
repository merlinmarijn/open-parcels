import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { isoNow, type Clock } from "../clock.js";
import { DecryptionError, type SecretBox } from "../crypto/secrets.js";
import type { Database, ConnectionRow } from "../db/schema.js";
import type { EventBus } from "../events/bus.js";
import {
  CaptchaError,
  RateLimitedError,
  SignInRejectedError,
  TransientError,
  type FetchResult,
  type LiveReading,
  type LiveTarget,
  type ProviderLogger,
  type SessionStore,
} from "../provider/api.js";
import { coreHttp, type HostLimiter, type ProviderHttp } from "../provider/http.js";
import { redactText } from "../log/redact.js";
import type { FetchLike } from "../net/guarded-fetch.js";
import { fallbackProviders, linkFallbacks } from "./fallback.js";
import { KeyedMutex } from "./locks.js";
import type { FailureKind } from "./policy.js";
import type { LiveTargetOfParcel, Reconciler } from "./reconciler.js";
import {
  InvalidConnectionConfigError,
  type BaseContext,
  type ProviderRegistry,
  type RegisteredProvider,
} from "./registry.js";
import { secretAad, sessionAad } from "./connections.js";
import { cause, type StateCause } from "./state-reason.js";
import { recordUnknown } from "./vocab.js";

export type RunOutcome =
  | {
      readonly ok: true;
      readonly created: number;
      readonly updated: number;
      readonly events: number;
      readonly liveTargets: readonly LiveTargetOfParcel[];
      /** Why the provider did nothing, when it chose to; such a run is not a success. */
      readonly idle?: string;
    }
  | {
      readonly ok: false;
      readonly kind: FailureKind;
      readonly why: StateCause;
      readonly retryAfterSeconds?: number;
    };

export interface RunnerDeps {
  readonly db: Kysely<Database>;
  readonly registry: ProviderRegistry;
  readonly secrets: SecretBox;
  readonly reconciler: Reconciler;
  readonly limiter: HostLimiter;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike;
}

function classify(error: unknown): {
  kind: FailureKind;
  why: StateCause;
  retryAfterSeconds?: number;
} {
  if (error instanceof SignInRejectedError) {
    return { kind: "sign_in_rejected", why: cause("sign_in_rejected") };
  }
  if (error instanceof RateLimitedError) {
    return {
      kind: "rate_limited",
      why: cause("rate_limited"),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }
  if (error instanceof CaptchaError) {
    return { kind: "captcha", why: cause("captcha") };
  }
  if (error instanceof InvalidConnectionConfigError) {
    return { kind: "invalid_config", why: cause("invalid_config", error.message) };
  }
  if (error instanceof DecryptionError) {
    return { kind: "sign_in_rejected", why: cause("sign_in_unreadable") };
  }
  if (error instanceof TransientError) {
    // The provider said what broke (an HTTP status, a changed response); pass it on, scrubbed.
    return { kind: "transient", why: cause("update_failed", redactText(error.message)) };
  }
  return { kind: "transient", why: cause("update_failed") };
}

interface TrackedParcel {
  readonly id: string;
  readonly tracking_number: string;
  readonly carrier: string;
}

/** A fallback service's answers, each filed under the carrier of the parcel it was asked about. */
function underParcelCarrier(result: FetchResult, tracked: readonly TrackedParcel[]): FetchResult {
  const carrierOf = new Map(tracked.map((parcel) => [parcel.tracking_number, parcel.carrier]));
  return {
    ...result,
    snapshots: result.snapshots.map((found) => {
      const carrier = carrierOf.get(found.trackingNumber);
      return carrier === undefined ? found : { ...found, carrier };
    }),
  };
}

/** Runs one connection: calls its provider and hands the result to the reconciler. */
export class ConnectionRunner {
  #reports: Promise<void> = Promise.resolve();
  /** At most one request at a time per account: runs, live reads and sign-in steps queue here. */
  readonly #locks = new KeyedMutex();

  constructor(private readonly deps: RunnerDeps) {}

  /** Runs `work` while holding the connection's lock; sign-in steps go through this too. */
  async exclusive<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
    return this.#locks.exclusive(connectionId, work);
  }

  async run(connectionId: string): Promise<RunOutcome> {
    return this.exclusive(connectionId, () => this.#run(connectionId));
  }

  async #run(connectionId: string): Promise<RunOutcome> {
    const { db, registry } = this.deps;
    const row = await db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", connectionId)
      .executeTakeFirst();
    const provider = row === undefined ? undefined : registry.get(row.provider);
    if (row === undefined || provider === undefined) {
      return {
        ok: false,
        kind: "invalid_config",
        why: cause("provider_missing"),
      };
    }
    const log = this.deps.logger.child({ provider: row.provider, connection: row.id });
    try {
      const { result, asked } = await this.#fetch(row, provider, log);
      if (result.idle !== undefined) {
        // Nothing was asked, so nothing is reconciled: an empty answer must not count as "not found".
        return { ok: true, created: 0, updated: 0, events: 0, liveTargets: [], idle: result.idle };
      }
      // Let this run's unknown-value reports land before its result is applied.
      await this.#reports;
      const summary = await this.deps.reconciler.ingest(row.id, result, asked);
      if (row.kind === "tracking") {
        // What this run did not find may now be due for a fallback service.
        await linkFallbacks(this.deps.db, this.deps.registry, this.deps.clock);
      }
      if (asked.length > 0) {
        // Counts only: the codes themselves never go to the log.
        log.info(
          { asked: summary.asked, found: summary.found },
          "Asked the carrier about tracked codes.",
        );
      }
      return { ok: true, ...summary };
    } catch (error) {
      const classified = classify(error);
      // Nothing was ever stored, so nothing was rejected: the connection simply awaits its sign-in.
      const outcome =
        classified.kind === "sign_in_rejected" &&
        row.secret_blob === null &&
        row.session_blob === null
          ? { ...classified, why: cause("not_signed_in_yet") }
          : classified;
      if (outcome.kind === "transient" && !(error instanceof TransientError)) {
        // Not a failure the provider signalled: most likely a bug. Keep the stack for diagnosis.
        log.error({ err: error }, "Connection run failed unexpectedly.");
      } else {
        log.warn(
          { failure: outcome.kind, error: error instanceof Error ? error.message : String(error) },
          "Connection run failed.",
        );
      }
      return { ok: false, ...outcome };
    }
  }

  /**
   * A rate-limited HTTP client for a provider, for work outside a connection run (sign-in), held
   * to the hosts its manifest allows for this config.
   */
  httpFor(provider: RegisteredProvider, rawConfig: unknown): ProviderHttp {
    return coreHttp(
      provider.http,
      provider.hostsFor(rawConfig),
      this.deps.limiter,
      this.deps.clock,
      this.deps.fetchImpl,
    );
  }

  /**
   * Reads one live courier map. Errors propagate to the live tracker, which owns the retry rules;
   * none of them ever triggers a new sign-in here.
   */
  async readLive(connectionId: string, target: LiveTarget): Promise<LiveReading | null> {
    return this.exclusive(connectionId, () => this.#readLive(connectionId, target));
  }

  async #readLive(connectionId: string, target: LiveTarget): Promise<LiveReading | null> {
    const row = await this.deps.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", connectionId)
      .executeTakeFirst();
    const provider = row === undefined ? undefined : this.deps.registry.get(row.provider);
    if (row === undefined || provider?.canReadLive !== true) {
      return null;
    }
    const { base, config, secret } = this.#prepare(
      row,
      provider,
      this.deps.logger.child({ provider: row.provider, connection: row.id, live: true }),
    );
    return provider.readLive(base, config, secret, target);
  }

  /** Runs the provider; for a tracking connection also returns the ids of the parcels it asked about. */
  async #fetch(
    row: ConnectionRow,
    provider: RegisteredProvider,
    log: Logger,
  ): Promise<{ result: FetchResult; asked: readonly string[] }> {
    const { base, config, secret } = this.#prepare(row, provider, log);
    if (row.kind !== "tracking") {
      return { result: await provider.fetchAccount(base, config, secret), asked: [] };
    }
    const tracked = await this.#trackedParcels(row.id);
    if (tracked.length === 0) {
      return { result: { snapshots: [], complete: false }, asked: [] };
    }
    const answer = await provider.track(
      base,
      config,
      secret,
      tracked.map((parcel) => parcel.tracking_number),
    );
    // A fallback service answers for parcels of other carriers: filed under the parcel's own.
    const result = provider.info.fallback ? underParcelCarrier(answer, tracked) : answer;
    // Once a parcel is handed to a fallback service, that service's answers say whether it is
    // found; its carrier's "not found" no longer does.
    const handedOver = provider.info.fallback ? new Set<string>() : await this.#handedOver(tracked);
    const really = result.asked === undefined ? undefined : new Set(result.asked);
    return {
      result,
      asked: tracked
        .filter((parcel) => really === undefined || really.has(parcel.tracking_number))
        .filter((parcel) => !handedOver.has(parcel.id))
        .map((parcel) => parcel.id),
    };
  }

  /** Parcels among `tracked` that a fallback tracking service also follows. */
  async #handedOver(tracked: readonly { id: string }[]): Promise<Set<string>> {
    const providers = fallbackProviders(this.deps.registry);
    if (tracked.length === 0 || providers.length === 0) return new Set();
    const rows = await this.deps.db
      .selectFrom("parcel_connections")
      .innerJoin("connections", "connections.id", "parcel_connections.connection_id")
      .select("parcel_connections.parcel_id")
      .where(
        "parcel_connections.parcel_id",
        "in",
        tracked.map((parcel) => parcel.id),
      )
      .where("connections.provider", "in", providers)
      .execute();
    return new Set(rows.map((row) => row.parcel_id));
  }

  #prepare(
    row: ConnectionRow,
    provider: RegisteredProvider,
    log: Logger,
  ): { base: BaseContext; config: unknown; secret: unknown } {
    const secret =
      row.secret_blob === null
        ? null
        : this.deps.secrets.decryptJson(row.secret_blob, secretAad(row.id));
    const config = JSON.parse(row.config) as unknown;
    const base: BaseContext = {
      connectionId: row.id,
      http: this.httpFor(provider, config),
      clock: this.deps.clock,
      logger: this.#providerLogger(log),
      session: this.#sessionStore(row),
      reportUnknown: (kind, key) => {
        // Reports are written one after another (two reports of a new key would otherwise race
        // into a duplicate insert) and never fail the run.
        this.#reports = this.#reports
          .then(() => this.#reportUnknown(row.provider, kind, key, log))
          .catch((error: unknown) => {
            log.error({ err: error }, "Recording an unrecognised value failed.");
          });
      },
    };
    return { base, config, secret };
  }

  async #trackedParcels(connectionId: string): Promise<TrackedParcel[]> {
    return (
      this.deps.db
        .selectFrom("parcel_connections")
        .innerJoin("parcels", "parcels.id", "parcel_connections.parcel_id")
        .select(["parcels.id", "parcels.tracking_number", "parcels.carrier"])
        .where("parcel_connections.connection_id", "=", connectionId)
        .where("parcels.delivered", "=", 0)
        // Marked delivered by hand: the owner closed it, so the carrier is not asked any more.
        .where((eb) =>
          eb.or([
            eb("parcels.manual_status", "is", null),
            eb("parcels.manual_status", "!=", "delivered"),
          ]),
        )
        .where("parcels.archived_at", "is", null)
        .execute()
    );
  }

  #providerLogger(log: Logger): ProviderLogger {
    return {
      debug: (context, message) => {
        log.debug(context, message);
      },
      info: (context, message) => {
        log.info(context, message);
      },
      warn: (context, message) => {
        log.warn(context, message);
      },
    };
  }

  #sessionStore(row: ConnectionRow): SessionStore {
    let cached: unknown =
      row.session_blob === null
        ? undefined
        : this.deps.secrets.decryptJson(row.session_blob, sessionAad(row.id));
    return {
      load: () => cached,
      save: async (value) => {
        cached = value;
        await this.deps.db
          .updateTable("connections")
          .set({
            session_blob: this.deps.secrets.encryptJson(value, sessionAad(row.id)),
            updated_at: isoNow(this.deps.clock),
          })
          .where("id", "=", row.id)
          .execute();
      },
    };
  }

  async #reportUnknown(provider: string, kind: string, key: string, log: Logger): Promise<void> {
    await recordUnknown(this.deps, { provider, kind, key }, log);
  }
}
