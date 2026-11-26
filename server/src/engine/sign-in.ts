import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import { isoNow, type Clock } from "../clock.js";
import { DecryptionError, type SecretBox } from "../crypto/secrets.js";
import type { Database } from "../db/schema.js";
import {
  CaptchaError,
  RateLimitedError,
  SignInRejectedError,
  TransientError,
  type SignInInput,
  type SignInStep,
  type SignInTurn,
} from "../provider/api.js";
import type { ProviderHttp } from "../provider/http.js";
import {
  InvalidConnectionConfigError,
  type ProviderRegistry,
  type RegisteredProvider,
  type SignInCall,
  type SignInFlowInfo,
} from "./registry.js";
import type { ConnectionService, ConnectionView } from "./connections.js";

/** How long a step waits for the user's answer. Approval steps use their own timeout. */
const ATTEMPT_TTL_MS = 15 * 60_000;
/** Refused codes, wrong pastes and the like before the attempt is dropped. */
const MAX_FAILURES = 5;
/** How long to wait after a captcha before the same step is tried again. */
const CAPTCHA_RETRY_SECONDS = 15 * 60;

export type SignInErrorCode =
  | "sign_in_expired"
  | "sign_in_captcha"
  | "sign_in_timeout"
  | "sign_in_refused"
  | "sign_in_failed"
  | "sign_in_unavailable"
  | "sign_in_wrong_step"
  | "sign_in_poll_too_soon"
  | "no_sign_in"
  | "invalid_connection"
  | "not_found";

/** A failure the routes turn into an API error. Messages are safe to show. */
export class SignInError extends Error {
  override readonly name = "SignInError";

  constructor(
    readonly code: SignInErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
    /** Values for the client's own text (`seconds`, or an invalid connection's `reason`). */
    readonly params: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
  }
}

export type AttemptView =
  | {
      readonly status: "step";
      readonly attemptId: string;
      readonly flow: string;
      readonly expiresAt: string;
      readonly step: SignInStep;
    }
  | { readonly status: "done" };

export interface SignInDeps {
  readonly db: Kysely<Database>;
  readonly registry: ProviderRegistry;
  readonly connections: ConnectionService;
  readonly secrets: SecretBox;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly httpFor: (provider: RegisteredProvider, rawConfig: unknown) => ProviderHttp;
  /** The per-connection lock shared with runs and live reads (`ConnectionRunner.exclusive`). */
  readonly exclusive?: <T>(connectionId: string, work: () => Promise<T>) => Promise<T>;
}

const message = z.string().exactOptional();
/** A stored step, checked against the shape providers return before it is used again. */
const stepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("form"),
    fields: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        type: z.enum(["text", "email", "password", "tel"]),
      }),
    ),
    message,
  }),
  z.object({
    kind: z.literal("open_url"),
    url: z.string(),
    message,
    redirectPrefix: z.string().exactOptional(),
    resumeUrl: z.string().exactOptional(),
  }),
  z.object({ kind: z.literal("email_link"), destination: z.string().nullable(), message }),
  z.object({
    kind: z.literal("otp_code"),
    channel: z.enum(["sms", "email", "app", "other"]),
    destination: z.string().nullable(),
    message,
  }),
  z.object({
    kind: z.literal("choose_method"),
    options: z.array(z.object({ id: z.string(), label: z.string() })),
    message,
  }),
  z.object({
    kind: z.literal("await_approval"),
    message: z.string(),
    pollIntervalSeconds: z.number(),
    timeoutSeconds: z.number(),
  }),
]) satisfies z.ZodType<SignInStep>;
const storedSchema = z.object({ state: z.unknown(), step: stepSchema });

const attemptAad = (attemptId: string, connectionId: string): string =>
  `sign-in:${attemptId}:${connectionId}`;

/** The keys the step's input must have, or why it cannot take input at all. */
function checkedInput(step: SignInStep, input: SignInInput): SignInInput {
  const missing = (): never => {
    throw new SignInError("sign_in_failed", "Fill in every field of this step.");
  };
  const value = (key: string): string => {
    const raw = input[key];
    return raw === undefined || raw.trim() === "" ? missing() : raw;
  };
  switch (step.kind) {
    case "form":
      return Object.fromEntries(step.fields.map((field) => [field.name, value(field.name)]));
    case "open_url":
      return { pasted: value("pasted").trim() };
    case "email_link":
    case "otp_code":
      return { code: value("code").trim() };
    case "choose_method": {
      const choice = value("choice");
      if (!step.options.some((option) => option.id === choice)) {
        throw new SignInError("sign_in_failed", "Choose one of the offered methods.");
      }
      return { choice };
    }
    case "await_approval":
      throw new SignInError(
        "sign_in_wrong_step",
        "This step waits for an approval; poll it instead of sending input.",
      );
  }
}

/**
 * Interactive sign-ins. The provider's state lives encrypted in `sign_in_attempts`, bound to the
 * attempt and its connection, and is never logged. One attempt per connection; a new start replaces it.
 * A carrier that cannot be reached leaves the attempt as it was, so a network error never sends
 * the user back to the start.
 */
export class SignInService {
  constructor(private readonly deps: SignInDeps) {}

  async flows(connectionId: string): Promise<SignInFlowInfo[]> {
    const { connection, provider } = await this.#connection(connectionId);
    return connection.kind === "mail"
      ? []
      : provider.signInFlows(connection.kind, connection.config);
  }

  /** The connection's lock: one carrier conversation per account, shared with runs and live reads. */
  async #locked<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
    return this.deps.exclusive === undefined ? work() : this.deps.exclusive(connectionId, work);
  }

  async start(connectionId: string, flowId?: string): Promise<AttemptView> {
    return this.#locked(connectionId, () => this.#start(connectionId, flowId));
  }

  async continue(
    connectionId: string,
    attemptId: string,
    input: SignInInput,
  ): Promise<AttemptView> {
    // Read the step outside the lock: a second submit that queued behind the first finds the
    // attempt changed (or gone) and is refused instead of reaching the carrier again.
    const seen = await this.#version(connectionId, attemptId);
    return this.#locked(connectionId, () => this.#continue(connectionId, attemptId, input, seen));
  }

  async poll(connectionId: string, attemptId: string): Promise<AttemptView> {
    const seen = await this.#version(connectionId, attemptId);
    return this.#locked(connectionId, () => this.#poll(connectionId, attemptId, seen));
  }

  /** The stored blob is re-encrypted with a fresh IV on every change, so it serves as a version. */
  async #version(connectionId: string, attemptId: string): Promise<Buffer | undefined> {
    const row = await this.deps.db
      .selectFrom("sign_in_attempts")
      .select("blob")
      .where("id", "=", attemptId)
      .where("connection_id", "=", connectionId)
      .executeTakeFirst();
    return row?.blob;
  }

  #checkUnchanged(attempt: LoadedAttempt, seen: Buffer | undefined): void {
    if (seen !== undefined && !attempt.blob.equals(seen)) {
      throw new SignInError(
        "sign_in_wrong_step",
        "This step was already answered; continue with the step it led to.",
      );
    }
  }

  async #start(connectionId: string, flowId?: string): Promise<AttemptView> {
    const { connection, provider } = await this.#connection(connectionId);
    const flows =
      connection.kind === "mail" ? [] : provider.signInFlows(connection.kind, connection.config);
    const interactive = flows.filter((flow) => flow.type === "interactive");
    const flow =
      flowId === undefined ? interactive[0] : interactive.find((each) => each.id === flowId);
    if (flow === undefined) {
      throw new SignInError(
        "no_sign_in",
        "This connection has no such interactive sign-in; enter its sign-in data directly.",
      );
    }
    await this.#sweep(connectionId);
    const turn = await this.#guarded(null, () =>
      this.#call(provider, connection, { action: "start", flowId: flow.id }),
    );
    return this.#settle(connection, flow.id, null, turn, false);
  }

  async #continue(
    connectionId: string,
    attemptId: string,
    input: SignInInput,
    seen: Buffer | undefined,
  ): Promise<AttemptView> {
    const { connection, provider } = await this.#connection(connectionId);
    const attempt = await this.#load(connection.id, attemptId, false);
    this.#checkUnchanged(attempt, seen);
    const checked = checkedInput(attempt.step, input);
    const turn = await this.#guarded(attempt, () =>
      this.#call(provider, connection, {
        action: "continue",
        flowId: attempt.flow,
        state: attempt.state,
        input: checked,
      }),
    );
    return this.#settle(connection, attempt.flow, attempt, turn, false);
  }

  async #poll(
    connectionId: string,
    attemptId: string,
    seen: Buffer | undefined,
  ): Promise<AttemptView> {
    const { connection, provider } = await this.#connection(connectionId);
    const attempt = await this.#load(connection.id, attemptId, true);
    // A poll that queued behind another one meets the poll_not_before the first one stored and
    // gets "too soon"; a poll whose step has since moved on is refused like a stale continue.
    if (attempt.step.kind !== "await_approval") {
      this.#checkUnchanged(attempt, seen);
    }
    if (attempt.step.kind !== "await_approval") {
      throw new SignInError("sign_in_wrong_step", "This step does not wait for an approval.");
    }
    const now = this.deps.clock.now().getTime();
    const notBefore = attempt.pollNotBefore === null ? 0 : Date.parse(attempt.pollNotBefore);
    if (now < notBefore) {
      throw new SignInError(
        "sign_in_poll_too_soon",
        "Polled too soon; wait before asking again.",
        Math.ceil((notBefore - now) / 1000),
        { seconds: Math.ceil((notBefore - now) / 1000) },
      );
    }
    const turn = await this.#guarded(attempt, () =>
      this.#call(provider, connection, {
        action: "poll",
        flowId: attempt.flow,
        state: attempt.state,
      }),
    );
    return this.#settle(connection, attempt.flow, attempt, turn, true);
  }

  async cancel(connectionId: string, attemptId: string): Promise<boolean> {
    const result = await this.deps.db
      .deleteFrom("sign_in_attempts")
      .where("id", "=", attemptId)
      .where("connection_id", "=", connectionId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async #connection(
    connectionId: string,
  ): Promise<{ connection: ConnectionView; provider: RegisteredProvider }> {
    const connection = await this.deps.connections.get(connectionId);
    const provider =
      connection === undefined ? undefined : this.deps.registry.get(connection.provider);
    if (connection === undefined || provider === undefined) {
      throw new SignInError("not_found", "The connection was not found.");
    }
    return { connection, provider };
  }

  async #call(
    provider: RegisteredProvider,
    connection: ConnectionView,
    call: Pick<SignInCall, "action" | "flowId" | "state" | "input">,
  ): Promise<SignInTurn<unknown>> {
    if (connection.kind === "mail") {
      throw new SignInError("no_sign_in", "Inboxes sign in with their own form.");
    }
    try {
      return await provider.signInTurn({
        ...call,
        kind: connection.kind,
        rawConfig: connection.config,
        http: this.deps.httpFor(provider, connection.config),
        clock: this.deps.clock,
      });
    } catch (error) {
      // Only the error's type is logged: messages and inputs may hold codes or addresses.
      this.deps.logger.warn(
        {
          provider: provider.info.id,
          flow: call.flowId,
          action: call.action,
          error: error instanceof Error ? error.name : "unknown",
        },
        "A sign-in step failed.",
      );
      throw error;
    }
  }

  /** Maps provider errors; failures count against the attempt, unreachable carriers do not. */
  async #guarded(
    attempt: LoadedAttempt | null,
    run: () => Promise<SignInTurn<unknown>>,
  ): Promise<SignInTurn<unknown>> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof TransientError || error instanceof RateLimitedError) {
        throw new SignInError(
          "sign_in_unavailable",
          "The carrier could not be reached. Your sign-in is kept; try the same step again.",
          error instanceof RateLimitedError ? error.retryAfterSeconds : undefined,
        );
      }
      if (error instanceof CaptchaError) {
        // Not the user's fault, so not a failed try; the step is kept for after the wait.
        throw new SignInError(
          "sign_in_captcha",
          "The carrier showed a captcha. Your sign-in is kept; wait a while, then try the same step again.",
          CAPTCHA_RETRY_SECONDS,
        );
      }
      if (error instanceof InvalidConnectionConfigError) {
        throw new SignInError("invalid_connection", error.message, undefined, {
          reason: error.reason,
          ...error.values,
        });
      }
      if (attempt !== null) {
        await this.#fail(attempt);
      }
      throw error instanceof SignInRejectedError
        ? new SignInError("sign_in_refused", "The carrier refused that. Check it and try again.")
        : new SignInError("sign_in_failed", "That did not work. Check it and try again.");
    }
  }

  /**
   * Counts a failed try in the row itself, never from the copy read before the carrier call, so
   * failures that end at the same time are all counted.
   */
  async #fail(attempt: LoadedAttempt): Promise<void> {
    const row = await this.deps.db
      .updateTable("sign_in_attempts")
      .set((eb) => ({ failures: eb("failures", "+", 1) }))
      .where("id", "=", attempt.id)
      .returning("failures")
      .executeTakeFirst();
    if (row !== undefined && row.failures >= MAX_FAILURES) {
      await this.cancel(attempt.connectionId, attempt.id);
    }
  }

  /** Stores the next step, or the finished secret. */
  async #settle(
    connection: ConnectionView,
    flow: string,
    previous: LoadedAttempt | null,
    turn: SignInTurn<unknown>,
    polled: boolean,
  ): Promise<AttemptView> {
    if ("secret" in turn) {
      await this.deps.db
        .deleteFrom("sign_in_attempts")
        .where("connection_id", "=", connection.id)
        .execute();
      await this.deps.connections.setSecret(connection.id, turn.secret);
      return { status: "done" };
    }
    const now = this.deps.clock.now().getTime();
    const waiting = turn.step.kind === "await_approval" ? turn.step : null;
    // A poll that is still waiting keeps the approval's deadline; anything else gets a fresh one.
    const expiresAt =
      polled && waiting !== null && previous !== null
        ? previous.expiresAt
        : new Date(
            now + (waiting === null ? ATTEMPT_TTL_MS : waiting.timeoutSeconds * 1000),
          ).toISOString();
    const pollNotBefore =
      waiting === null ? null : new Date(now + waiting.pollIntervalSeconds * 1000).toISOString();
    const id = previous?.id ?? randomUUID();
    const blob = this.deps.secrets.encryptJson(
      { state: turn.state, step: turn.step },
      attemptAad(id, connection.id),
    );
    if (previous === null) {
      await this.deps.db
        .insertInto("sign_in_attempts")
        .values({
          id,
          connection_id: connection.id,
          flow,
          blob,
          created_at: isoNow(this.deps.clock),
          expires_at: expiresAt,
          poll_not_before: pollNotBefore,
        })
        .execute();
    } else {
      const updated = await this.deps.db
        .updateTable("sign_in_attempts")
        .set({ blob, expires_at: expiresAt, poll_not_before: pollNotBefore })
        .where("id", "=", id)
        .executeTakeFirst();
      // Cancelled (the dialog closed, a new start) while the carrier answered: never hand back a
      // step of an attempt that no longer exists.
      if (updated.numUpdatedRows === 0n) {
        throw new SignInError("sign_in_expired", "Start the sign-in again; this attempt is gone.");
      }
    }
    return { status: "step", attemptId: id, flow, expiresAt, step: turn.step };
  }

  async #load(connectionId: string, attemptId: string, polling: boolean): Promise<LoadedAttempt> {
    const row = await this.deps.db
      .selectFrom("sign_in_attempts")
      .selectAll()
      .where("id", "=", attemptId)
      .where("connection_id", "=", connectionId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new SignInError("sign_in_expired", "Start the sign-in again; this attempt is gone.");
    }
    let stored: z.infer<typeof storedSchema>;
    try {
      stored = storedSchema.parse(
        this.deps.secrets.decryptJson(row.blob, attemptAad(row.id, row.connection_id)),
      );
    } catch (error) {
      if (!(error instanceof DecryptionError || error instanceof z.ZodError)) {
        throw error;
      }
      // Damaged or moved state: drop it rather than hand garbage to the provider.
      this.deps.logger.warn(
        { connection: connectionId },
        "A stored sign-in attempt could not be read.",
      );
      await this.cancel(connectionId, attemptId);
      throw new SignInError("sign_in_expired", "Start the sign-in again; this attempt is gone.");
    }
    const { step } = stored;
    if (Date.parse(row.expires_at) <= this.deps.clock.now().getTime()) {
      await this.cancel(connectionId, attemptId);
      throw polling && step.kind === "await_approval"
        ? new SignInError("sign_in_timeout", "The approval did not arrive in time. Start again.")
        : new SignInError("sign_in_expired", "Start the sign-in again; the attempt expired.");
    }
    return {
      id: row.id,
      blob: row.blob,
      connectionId,
      flow: row.flow,
      state: stored.state,
      step,
      failures: row.failures,
      expiresAt: row.expires_at,
      pollNotBefore: row.poll_not_before,
    };
  }

  /** Drops this connection's attempts and every expired one. */
  async #sweep(connectionId: string): Promise<void> {
    await this.deps.db
      .deleteFrom("sign_in_attempts")
      .where((eb) =>
        eb.or([
          eb("connection_id", "=", connectionId),
          eb("expires_at", "<=", isoNow(this.deps.clock)),
        ]),
      )
      .execute();
  }
}

interface LoadedAttempt {
  readonly id: string;
  /** The encrypted row as read; it changes on every update. */
  readonly blob: Buffer;
  readonly connectionId: string;
  readonly flow: string;
  readonly state: unknown;
  readonly step: SignInStep;
  readonly failures: number;
  readonly expiresAt: string;
  readonly pollNotBefore: string | null;
}
