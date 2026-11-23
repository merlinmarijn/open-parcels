import type { Kysely } from "kysely";
import { simpleParser, type AddressObject } from "mailparser";
import type { Logger } from "pino";
import { ZodError } from "zod";
import { isoNow, type Clock } from "../clock.js";
import { DecryptionError, type SecretBox } from "../crypto/secrets.js";
import type { Database, SourceRow } from "../db/schema.js";
import type { Reconciler } from "../engine/reconciler.js";
import { secretAad, sessionAad, type SourceService } from "../engine/sources.js";
import type { ParcelSnapshot } from "../plugin/snapshot.js";
import {
  MAIL_PLUGIN,
  mailConfigSchema,
  mailProgressSchema,
  mailSecretSchema,
  type FetchedMessage,
  type MailboxClient,
  type MailboxClientFactory,
  type MailConfig,
  type MailInput,
  type MailInterpreter,
  type MailProgress,
  type MailSecret,
  isGenericMailboxLabel,
  mailboxLabel,
} from "./types.js";

const DAY = 24 * 60 * 60 * 1000;
const RESYNC_MS = 15 * 60_000;
const RECONNECT_BASE_MS = 30_000;
const RECONNECT_MAX_MS = 15 * 60_000;

export interface MailWatcherDeps {
  readonly db: Kysely<Database>;
  readonly secrets: SecretBox;
  readonly sources: SourceService;
  readonly reconciler: Reconciler;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly clientFactory: MailboxClientFactory;
  readonly interpret: MailInterpreter;
  /** Links parcels found in mail to their carrier's tracking source, so they get polled. */
  readonly followUp: (sourceId: string) => Promise<void>;
}

interface Connection {
  readonly client: MailboxClient;
  readonly config: MailConfig;
  progress: MailProgress;
  syncing: Promise<void>;
  resync: ReturnType<typeof setInterval> | undefined;
}

function isAuthFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "authenticationFailed" in error &&
    error.authenticationFailed === true
  );
}

function addressText(value: AddressObject | AddressObject[] | undefined): string {
  if (value === undefined) {
    return "";
  }
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => entry.value.map((address) => address.address ?? "")).join(", ");
}

/** A Date header this far ahead of now is a sender's wrong clock, not a time to trust. */
const FUTURE_SKEW_MS = 15 * 60_000;

/**
 * The time a mail stands for: its Date header when that is plausible, else when the server
 * received it. A missing header never becomes "now", and a future-dated one never becomes the
 * parcel's status time (which would block carrier updates until it passed).
 */
export function mailDate(header: Date | null, receivedAt: Date | null, now: Date): Date | null {
  const plausible = (date: Date | null): date is Date =>
    date !== null &&
    !Number.isNaN(date.getTime()) &&
    date.getTime() <= now.getTime() + FUTURE_SKEW_MS;
  if (plausible(header)) {
    return header;
  }
  return plausible(receivedAt) ? receivedAt : null;
}

export async function toMailInput(
  source: Buffer,
  receivedAt: Date | null = null,
  now: Date = new Date(),
): Promise<MailInput> {
  const parsed = await simpleParser(source, { skipImageLinks: true });
  return {
    messageId: parsed.messageId ?? null,
    from: addressText(parsed.from),
    subject: parsed.subject ?? "",
    text: parsed.text ?? null,
    html: typeof parsed.html === "string" ? parsed.html : null,
    date: mailDate(parsed.date ?? null, receivedAt, now),
  };
}

/** Watches every mailbox source over IMAP IDLE and feeds what it finds to the reconciler. */
export class MailWatcher {
  readonly #connections = new Map<string, Connection>();
  readonly #retries = new Map<string, number>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #stopped = true;

  constructor(private readonly deps: MailWatcherDeps) {}

  async start(): Promise<void> {
    this.#stopped = false;
    const rows = await this.deps.db
      .selectFrom("sources")
      .selectAll()
      .where("kind", "=", "mail")
      .where("state", "in", ["ok", "error"])
      .execute();
    const results = await Promise.allSettled(rows.map((row) => this.connect(row.id)));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        // One mailbox must never keep the server from starting.
        this.deps.logger.error(
          { err: result.reason, source: rows[index]?.id },
          "Starting a mailbox failed.",
        );
      }
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    await Promise.all([...this.#connections.keys()].map((id) => this.disconnect(id)));
  }

  /** (Re)connects one mailbox source; safe to call after its settings or sign-in changed. */
  async connect(sourceId: string): Promise<void> {
    await this.disconnect(sourceId);
    const row = await this.deps.db
      .selectFrom("sources")
      .selectAll()
      .where("id", "=", sourceId)
      .executeTakeFirst();
    if (
      row?.kind !== "mail" ||
      row.plugin !== MAIL_PLUGIN ||
      row.secret_blob === null ||
      this.#stopped
    ) {
      return;
    }
    const opened = await this.#open(row, row.secret_blob);
    if (opened === undefined) {
      return;
    }
    const { config, secret, progress } = opened;
    if (isGenericMailboxLabel(row.label, config.host)) {
      await this.deps.db
        .updateTable("sources")
        .set({ label: mailboxLabel(secret.username, config.host) })
        .where("id", "=", row.id)
        .execute();
    }
    const client = this.deps.clientFactory(config, secret);
    const connection: Connection = {
      client,
      config,
      progress,
      syncing: Promise.resolve(),
      resync: undefined,
    };
    try {
      await client.connect();
    } catch (error) {
      await this.#failed(sourceId, error);
      return;
    }
    this.#connections.set(sourceId, connection);
    this.#retries.delete(sourceId);
    client.onClose((error) => {
      if (this.#connections.get(sourceId) === connection) {
        this.#connections.delete(sourceId);
        this.#failed(sourceId, error ?? new Error("The mail server closed the connection.")).catch(
          (failure: unknown) => {
            this.deps.logger.error(
              { err: failure, source: sourceId },
              "Handling a closed mailbox failed.",
            );
          },
        );
      }
    });
    client.onNewMail(() => {
      this.#queueSync(sourceId, connection, [config.folders[0] ?? "INBOX"]);
    });
    connection.resync = setInterval(() => {
      this.#queueSync(sourceId, connection, config.folders);
    }, RESYNC_MS);
    connection.resync.unref();
    // The first sync (up to `initialDays` of mail) runs on in the background: adding a mailbox or
    // starting the server does not wait for it. Its failures go to #failed like any other.
    this.#queueSync(sourceId, connection, config.folders);
  }

  /** Resolves once the syncs queued so far on this mailbox have run. */
  async settled(sourceId: string): Promise<void> {
    await this.#connections.get(sourceId)?.syncing;
  }

  async disconnect(sourceId: string): Promise<void> {
    const connection = this.#connections.get(sourceId);
    this.#connections.delete(sourceId);
    if (connection === undefined) {
      return;
    }
    if (connection.resync !== undefined) {
      clearInterval(connection.resync);
    }
    // Let a sync that is already running finish; its own failures are handled inside the chain.
    await connection.syncing;
    await connection.client.close().catch((error: unknown) => {
      this.deps.logger.debug(
        { err: error, source: sourceId },
        "Closing the mail connection failed.",
      );
    });
  }

  /**
   * Reads a mailbox's stored settings and sign-in. A source that cannot be read (a changed
   * encryption key, settings in a bad shape) is marked and skipped, never allowed to stop the
   * other mailboxes or the server's start.
   */
  async #open(
    row: SourceRow,
    secretBlob: Buffer,
  ): Promise<{ config: MailConfig; secret: MailSecret; progress: MailProgress } | undefined> {
    try {
      const config = mailConfigSchema.parse(JSON.parse(row.config));
      const secret = mailSecretSchema.parse(
        this.deps.secrets.decryptJson(secretBlob, secretAad(row.id)),
      );
      return { config, secret, progress: this.#progress(row) };
    } catch (error) {
      if (error instanceof DecryptionError) {
        await this.deps.sources.setState(
          row.id,
          "needs_sign_in",
          "The stored sign-in could not be read. Enter the password again.",
        );
      } else if (error instanceof ZodError || error instanceof SyntaxError) {
        await this.deps.sources.setState(row.id, "error", "The mailbox settings are invalid.");
      } else {
        throw error;
      }
      this.deps.logger.warn(
        { source: row.id, error: error.name },
        "A mailbox source could not be read.",
      );
      return undefined;
    }
  }

  #progress(row: SourceRow): MailProgress {
    if (row.session_blob === null) {
      return {};
    }
    let stored: unknown;
    try {
      stored = this.deps.secrets.decryptJson(row.session_blob, sessionAad(row.id));
    } catch (error) {
      if (!(error instanceof DecryptionError)) {
        throw error;
      }
      // Only the read position is lost: the mailbox is read again from its first-sync window.
      return {};
    }
    const parsed = mailProgressSchema.safeParse(stored);
    return parsed.success ? parsed.data : {};
  }

  #queueSync(sourceId: string, connection: Connection, folders: readonly string[]): void {
    connection.syncing = connection.syncing
      .then(() => this.#sync(sourceId, connection, folders))
      .catch((error: unknown) => this.#failed(sourceId, error));
  }

  async #sync(sourceId: string, connection: Connection, folders: readonly string[]): Promise<void> {
    const snapshots: ParcelSnapshot[] = [];
    // Built on a copy and committed only once the mails are stored: a failed batch is read again
    // on the next sync, whatever else runs on the connection in between.
    let progress = connection.progress;
    // The first folder is opened last so it stays selected for IDLE.
    for (const folder of [...folders].reverse()) {
      const { uidValidity } = await connection.client.open(folder);
      const known = progress[folder];
      let lastUid = known?.uidValidity === uidValidity ? known.lastUid : 0;
      const readUpTo = lastUid;
      const messages: AsyncIterable<FetchedMessage> =
        known?.uidValidity === uidValidity
          ? connection.client.fetchAfter(lastUid)
          : connection.client.fetchUids(
              await connection.client.searchSince(
                new Date(this.deps.clock.now().getTime() - connection.config.initialDays * DAY),
              ),
            );
      for await (const message of messages) {
        // `UID FETCH n:*` returns the newest message even when nothing newer exists (`*` is the
        // highest UID, so the range turns around); it was read already.
        if (message.uid <= readUpTo) continue;
        lastUid = Math.max(lastUid, message.uid);
        const mail = await toMailInput(
          message.source,
          message.receivedAt ?? null,
          this.deps.clock.now(),
        );
        snapshots.push(...this.#interpret(sourceId, mail));
      }
      progress = { ...progress, [folder]: { uidValidity, lastUid } };
    }
    if (snapshots.length > 0) {
      await this.deps.reconciler.ingest(sourceId, { snapshots, complete: false });
      await this.deps.followUp(sourceId);
    }
    connection.progress = progress;
    await this.deps.db
      .updateTable("sources")
      .set({
        session_blob: this.deps.secrets.encryptJson(progress, sessionAad(sourceId)),
        last_run_at: isoNow(this.deps.clock),
        last_ok_at: isoNow(this.deps.clock),
      })
      .where("id", "=", sourceId)
      .execute();
    await this.deps.sources.setState(sourceId, "ok", null);
  }

  #interpret(sourceId: string, mail: MailInput): readonly ParcelSnapshot[] {
    try {
      return this.deps.interpret(mail);
    } catch (error) {
      // One odd mail must not stop the mailbox; the content is never logged.
      this.deps.logger.warn(
        { source: sourceId, error: error instanceof Error ? error.name : "unknown" },
        "A mail could not be interpreted.",
      );
      return [];
    }
  }

  async #failed(sourceId: string, error: unknown): Promise<void> {
    if (this.#stopped) {
      // Shutting down: connections closing now is expected, and the database may be gone.
      return;
    }
    if (isAuthFailure(error)) {
      await this.deps.sources.setState(
        sourceId,
        "needs_sign_in",
        "The mail server rejected the sign-in. Enter the password again.",
      );
      return;
    }
    if (this.#timers.has(sourceId)) {
      // A reconnect is already on its way: another failure before it runs must not add a second
      // one, or a refusing server gets a burst of reconnects.
      return;
    }
    const attempt = (this.#retries.get(sourceId) ?? 0) + 1;
    this.#retries.set(sourceId, attempt);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    this.deps.logger.warn(
      {
        source: sourceId,
        attempt,
        retryInMs: delay,
        error: error instanceof Error ? error.message : "unknown",
      },
      "Mailbox connection failed.",
    );
    await this.deps.sources.setState(
      sourceId,
      "error",
      "The mail server could not be reached; retrying.",
    );
    const timer = setTimeout(() => {
      this.#timers.delete(sourceId);
      if (this.#stopped) {
        return;
      }
      this.connect(sourceId).catch((failure: unknown) => {
        this.deps.logger.error(
          { err: failure, source: sourceId },
          "Reconnecting the mailbox failed.",
        );
      });
    }, delay);
    timer.unref();
    this.#timers.set(sourceId, timer);
  }
}
