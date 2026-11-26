import type { z } from "zod";
import type { Clock } from "../clock.js";
import type { HttpPolicy, ProviderHttp } from "./http.js";
import type { LiveReading, LiveTarget } from "./live.js";
import type { ProviderAction } from "./actions.js";
import type { SignInFlow } from "./sign-in.js";
import type { OrderSnapshot, ParcelSnapshot, ReturnSnapshot } from "./snapshot.js";

export * from "./actions.js";
export * from "./errors.js";
export * from "./kit/html.js";
export * from "./kit/json.js";
export * from "./kit/recheck.js";
export * from "./kit/time.js";
export * from "./kit/track.js";
export * from "./rules.js";
export * from "./snapshot.js";
export type { Clock } from "../clock.js";
export type { Direction } from "../domain/parcel.js";
export type { DropOffKind, DropOffOption, ReturnStatus } from "../domain/return.js";
export type { LiveReading, LiveTarget } from "./live.js";
export { CookieJar, restoreJar, serializeJar } from "./cookies.js";
export { sameSite } from "./http.js";
export type { HostLimit, HttpPolicy, HttpResponse, ProviderHttp, RequestOptions } from "./http.js";

/** Connection kinds a carrier can offer. Inboxes are handled by the core, not by carrier providers. */
export const CONNECTION_KINDS = ["account", "tracking", "shop"] as const;
export type ProviderConnectionKind = (typeof CONNECTION_KINDS)[number];

/** Minimal structured logger handed to providers. Messages are redacted before they are written. */
export interface ProviderLogger {
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

/** Encrypted per-connection storage for whatever the carrier renews: cookies, refresh tokens, device ids. */
export interface SessionStore {
  load(): unknown;
  save(value: unknown): Promise<void>;
}

export interface ProviderContext<Config, Secret> {
  readonly connectionId: string;
  readonly config: Config;
  readonly secret: Secret;
  readonly http: ProviderHttp;
  readonly clock: Clock;
  readonly logger: ProviderLogger;
  readonly session: SessionStore;
  /**
   * Reports a status code, text or response key the provider could not map. The core warns once
   * per new value and records it for the "please report this" list. Pass keys or codes, never
   * values that may carry personal data.
   */
  reportUnknown(kind: string, key: string): void;
}

export interface FetchResult {
  readonly snapshots: readonly ParcelSnapshot[];
  /** Returns the connection reported. They never count towards `complete`: a return is never "gone". */
  readonly returns?: readonly ReturnSnapshot[];
  /** Orders the connection reported without a parcel (order emails). Never count towards `complete`. */
  readonly orders?: readonly OrderSnapshot[];
  /**
   * True when the list is everything the connection currently has. Only complete results let the
   * reconciler conclude that a missing parcel is gone. Ignored for tracking connections: a lookup
   * never lists everything, and a code the carrier does not know goes through the not-found
   * lookup state instead.
   */
  readonly complete: boolean;
  /**
   * Set when the provider deliberately did nothing, saying why (for example "Public tracking off:
   * nothing to look up."). The run then claims no success: the connection keeps this as its carrier message,
   * its last successful run stays as it was, and nothing is reconciled.
   */
  readonly idle?: string;
  /**
   * Tracking connections only: the codes really looked up this run, when the provider could not ask
   * for all of them (a request budget, a pause). Codes outside it keep their lookup state instead
   * of reading "not found". Unset: every code passed to `track` was asked.
   */
  readonly asked?: readonly string[];
}

/**
 * One email the core routed to the provider: its sender's domain is one the manifest's `email`
 * section names, and the receiving server confirmed (DKIM or DMARC) that it really comes from
 * there. Never logged: it is personal data.
 */
export interface ProviderEmail {
  /** Stable per email (its Message-ID, else a digest); use it as the id of events it gives. */
  readonly id: string;
  readonly messageId: string | null;
  /** ISO 8601; null when the email gives no plausible time. */
  readonly date: string | null;
  readonly from: { readonly address: string; readonly name: string | null };
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
}

/**
 * What parsing an email may use: no network, no sign-in data and no session, so an email parser
 * is a pure function and an email cannot be sent anywhere.
 */
export interface EmailContext {
  readonly clock: Clock;
  readonly logger: ProviderLogger;
  reportUnknown(kind: string, key: string): void;
}

/** What a provider found in an email. */
export interface EmailResult {
  readonly snapshots: readonly ParcelSnapshot[];
  readonly orders?: readonly OrderSnapshot[];
  readonly returns?: readonly ReturnSnapshot[];
  /**
   * Set when the email is not one the provider reads, saying why; the core then reads it as an
   * email no provider claimed (the shared email rules). Without it the provider has read the email
   * in full, and the shared rules never see it, so one email never gives a parcel twice.
   */
  readonly ignored?: string;
}

export { pastedRedirect } from "./sign-in.js";
export type {
  InteractiveSignIn,
  SignInContext,
  SignInField,
  SignInFlow,
  SignInInput,
  SignInOption,
  SignInScope,
  SignInStep,
  SignInStepKind,
  SignInTurn,
  StaticSignIn,
} from "./sign-in.js";

/**
 * A carrier provider's code: its schemas, sign-in flows, pacing and behaviour. What it is (name,
 * countries, connection kinds) and what it may reach is in its manifest (`manifest.ts`), which the
 * core checks against this object when it registers the provider.
 */
export interface CarrierProvider<Config = unknown, Secret = unknown> {
  /** Equals the manifest's `id`. */
  readonly id: string;
  /**
   * A fixed time between runs instead of the adaptive schedule (and its night-time pause). Only
   * for connections that cost nothing to ask, like the demo providers.
   */
  readonly pollIntervalMs?: number;
  readonly configSchema: z.ZodType<Config>;
  readonly secretSchema: z.ZodType<Secret>;
  /**
   * How the user signs in: one flow, or several. With several, each flow's `kinds` and `when`
   * decide where it applies (DHL: the German account by pasted link, the Dutch one by password);
   * the first applicable one is the default.
   */
  readonly signIn: SignInFlow<Config, Secret> | readonly SignInFlow<Config, Secret>[];
  readonly http: HttpPolicy;
  /** Account and shop connections: return everything the account lists. */
  fetchAccount?(context: ProviderContext<Config, Secret>): Promise<FetchResult>;
  /**
   * Tracking connections: look up these codes. A missing code in the result means "not found", unless
   * the result's `asked` leaves it out.
   */
  track?(
    context: ProviderContext<Config, Secret>,
    trackingNumbers: readonly string[],
  ): Promise<FetchResult>;
  /**
   * Reads the courier map for one parcel. Returns null when there is no session. Must not sign
   * in again on a network error; renewing a token the carrier explicitly refused, once, is fine.
   */
  readLive?(
    context: ProviderContext<Config, Secret>,
    target: LiveTarget,
  ): Promise<LiveReading | null>;
  /**
   * Reads an email from a sender the manifest's `email` section names (`email.from_domains`);
   * exactly the providers with that section implement it.
   */
  parseEmail?(context: EmailContext, email: ProviderEmail): Promise<EmailResult>;
  /**
   * The code of the manifest's task actions, by action id (`defineAction`); exactly the manifest's
   * tasks, no more and no fewer. Each runs as a job (`docs/connection-actions-and-jobs.md`).
   */
  readonly actions?: Readonly<Record<string, ProviderAction<Config, Secret>>>;
}

/** Identity helper that keeps the generic parameters inferred from the schemas. */
export function defineCarrier<Config, Secret>(
  provider: CarrierProvider<Config, Secret>,
): CarrierProvider<Config, Secret> {
  return provider;
}
