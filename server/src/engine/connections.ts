import type { Kysely } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { SecretBox } from "../crypto/secrets.js";
import type { Database, ConnectionRow } from "../db/schema.js";
import { appendEvent, type EventBus } from "../events/bus.js";
import { MAIL_PROVIDER, mailConfigSchema, mailSecretSchema } from "../mail/types.js";
import { linkFallbacks } from "./fallback.js";
import {
  linkUntrackedParcels,
  trackingConnectionIn,
  type LinkOptions,
  type LinkResult,
} from "./linking.js";
import { InvalidConnectionConfigError, type ProviderRegistry } from "./registry.js";

export type ConnectionKind = ConnectionRow["kind"];
export type ConnectionState = ConnectionRow["state"];

/** Details of a connection no run has judged yet. */
export const NOT_SIGNED_IN_YET = "Not signed in yet.";
export const NOT_RUN_YET = "Not run yet.";

/**
 * Writes `connection.removed` inside the caller's transaction. `mergedInto` names the connection that
 * took over the removed one's parcels, when it was merged rather than deleted.
 */
export async function appendConnectionRemoved(
  trx: Kysely<Database>,
  clock: Clock,
  connection: { id: string; provider: string; label: string; kind: ConnectionKind },
  mergedInto: string | null,
): Promise<void> {
  await appendEvent(trx, clock, {
    type: "connection.removed",
    parcelId: null,
    payload: {
      connection: {
        id: connection.id,
        provider: connection.provider,
        label: connection.label,
        kind: connection.kind,
      },
      merged_into: mergedInto,
    },
  });
}

/**
 * Removes those of `connectionIds` that the app created on its own (keyless tracking connections made
 * when a code was added by hand) and that no parcel links to any more, firing `connection.removed`
 * for each inside the caller's transaction. Connections the user made or imported are never touched,
 * and neither is one that has gained sign-in data since. Returns how many were removed.
 */
export async function removeOrphanedAutoConnections(
  trx: Kysely<Database>,
  clock: Clock,
  connectionIds: readonly string[],
): Promise<number> {
  if (connectionIds.length === 0) {
    return 0;
  }
  const orphans = await trx
    .selectFrom("connections")
    .select(["id", "provider", "label", "kind"])
    .where("id", "in", connectionIds)
    .where("auto_created", "=", 1)
    .where("kind", "=", "tracking")
    // Sign-in data is the stored secret. The session store is not: keyless providers keep run
    // state there (cookies, rate budgets) on every run, so it says nothing about the user.
    .where("secret_blob", "is", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("parcel_connections")
            .select("parcel_connections.parcel_id")
            .whereRef("parcel_connections.connection_id", "=", "connections.id"),
        ),
      ),
    )
    .execute();
  for (const orphan of orphans) {
    await trx.deleteFrom("connections").where("id", "=", orphan.id).execute();
    await appendConnectionRemoved(trx, clock, orphan, null);
  }
  return orphans.length;
}

type EventRow = Pick<
  ConnectionRow,
  "id" | "provider" | "label" | "kind" | "state" | "state_detail"
>;

/** The payload of `connection.added`, `connection.updated` and `connection.run_finished`. */
function connectionPayload(row: EventRow): Record<string, unknown> {
  return {
    connection: { id: row.id, provider: row.provider, label: row.label, kind: row.kind },
    state: row.state,
    detail: row.state_detail,
  };
}

/** Associated data for a connection's encrypted blobs: a blob copied to another row fails to decrypt. */
export const secretAad = (connectionId: string): string => `source:${connectionId}:secret`;
export const sessionAad = (connectionId: string): string => `source:${connectionId}:session`;

export interface ConnectionView {
  readonly id: string;
  readonly provider: string;
  readonly kind: ConnectionKind;
  readonly label: string;
  readonly config: unknown;
  readonly hasSecret: boolean;
  readonly state: ConnectionState;
  readonly stateDetail: string | null;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastOkAt: string | null;
}

export interface NewConnection {
  readonly provider: string;
  readonly kind: ConnectionKind;
  readonly label: string;
  readonly config: unknown;
  readonly secret: unknown;
}

function toView(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    label: row.label,
    config: JSON.parse(row.config) as unknown,
    hasSecret: row.secret_blob !== null,
    state: row.state,
    stateDetail: row.state_detail,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastOkAt: row.last_ok_at,
  };
}

/** Creating, configuring and inspecting connections. Secrets never leave this class unencrypted. */
export class ConnectionService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly registry: ProviderRegistry,
    private readonly secrets: SecretBox,
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  async list(): Promise<ConnectionView[]> {
    const rows = await this.db
      .selectFrom("connections")
      .selectAll()
      .orderBy("created_at")
      .execute();
    return rows.map(toView);
  }

  async get(id: string): Promise<ConnectionView | undefined> {
    const row = await this.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : toView(row);
  }

  async create(input: NewConnection): Promise<ConnectionView> {
    const config = this.#validate(input);
    const id = crypto.randomUUID();
    const now = isoNow(this.clock);
    await this.db
      .insertInto("connections")
      .values({
        id,
        provider: input.provider,
        kind: input.kind,
        label: input.label,
        config: JSON.stringify(config),
        secret_blob:
          input.secret === null ? null : this.secrets.encryptJson(input.secret, secretAad(id)),
        session_blob: null,
        // Nothing has judged the connection yet; its first run (due at once) decides, and a run that
        // finds no stored sign-in says "not signed in yet", never "rejected".
        state: "ok",
        state_detail: input.kind === "mail" ? null : NOT_RUN_YET,
        // Inboxes are driven by the mail watcher (IMAP IDLE), never by the poll scheduler.
        next_run_at: input.kind === "mail" ? null : now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const created = await this.get(id);
    if (created === undefined) {
      throw new Error("Created connection could not be read back.");
    }
    await this.#announceConnection(id, "connection.added");
    return created;
  }

  /** Validates a new connection and returns its configuration with defaults applied. */
  #validate(input: NewConnection): unknown {
    if (input.kind === "mail" || input.provider === MAIL_PROVIDER) {
      if (input.kind !== "mail" || input.provider !== MAIL_PROVIDER) {
        throw new InvalidConnectionConfigError(
          `Inboxes use the provider "${MAIL_PROVIDER}" and the kind "mail".`,
        );
      }
      const config = mailConfigSchema.safeParse(input.config);
      const secret = mailSecretSchema.safeParse(input.secret);
      if (!config.success || !secret.success) {
        throw new InvalidConnectionConfigError(
          "The inbox needs a host, a username and a password.",
        );
      }
      return config.data;
    }
    const provider = this.registry.get(input.provider);
    if (provider === undefined) {
      throw new InvalidConnectionConfigError(
        `There is no carrier provider called ${input.provider}.`,
      );
    }
    if (!provider.info.connectionKinds.includes(input.kind)) {
      throw new InvalidConnectionConfigError(
        `${provider.info.name} has no ${input.kind} connection.`,
      );
    }
    const config = provider.validateConfig(input.config);
    if (input.secret !== null && !provider.info.secretSchema.safeParse(input.secret).success) {
      throw new InvalidConnectionConfigError(
        `The sign-in data does not fit ${provider.info.name}.`,
      );
    }
    return config;
  }

  /** Validates changed settings of an existing connection and returns them with defaults applied. */
  #validateChange(row: Pick<ConnectionRow, "provider" | "kind">, config: unknown): unknown {
    if (row.kind === "mail") {
      const parsed = mailConfigSchema.safeParse(config);
      if (!parsed.success) {
        throw new InvalidConnectionConfigError("The inbox needs a host.");
      }
      return parsed.data;
    }
    const provider = this.registry.get(row.provider);
    return provider === undefined ? config : provider.validateConfig(config);
  }

  /**
   * The tracking connection of a provider, created on first use. Codes the user adds by hand, and codes
   * handed over by shops, are tracked through it.
   */
  async ensureTrackingConnection(providerId: string): Promise<string> {
    const id = await trackingConnectionIn(this.db, this.registry, this.clock)(providerId);
    if (id === undefined) {
      throw new InvalidConnectionConfigError(
        `There is no carrier provider that tracks ${providerId}.`,
      );
    }
    return id;
  }

  /** Links active parcels no carrier connection follows to their tracking connection; see `linking.ts`. */
  async linkUntracked(options: LinkOptions = {}): Promise<LinkResult> {
    return linkUntrackedParcels(
      this.db,
      this.clock,
      trackingConnectionIn(this.db, this.registry, this.clock),
      options,
    );
  }

  /** Hands parcels no carrier follows or finds to the fallback services; see `fallback.ts`. */
  async linkFallbacks(): Promise<number> {
    return linkFallbacks(this.db, this.registry, this.clock);
  }

  /**
   * Checks sign-in data against the connection's provider before it is stored, so a malformed secret
   * is refused at once instead of failing every later run. Throws InvalidConnectionConfigError.
   */
  async checkSecret(id: string, secret: unknown): Promise<void> {
    const row = await this.db
      .selectFrom("connections")
      .select(["provider", "kind"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      return;
    }
    if (row.kind === "mail") {
      if (!mailSecretSchema.safeParse(secret).success) {
        throw new InvalidConnectionConfigError("The inbox needs a username and a password.");
      }
      return;
    }
    const provider = this.registry.get(row.provider);
    if (provider !== undefined && !provider.info.secretSchema.safeParse(secret).success) {
      throw new InvalidConnectionConfigError(
        `The sign-in data does not fit ${provider.info.name}.`,
      );
    }
  }

  async setSecret(id: string, secret: unknown): Promise<void> {
    await this.db
      .updateTable("connections")
      .set({
        secret_blob: this.secrets.encryptJson(secret, secretAad(id)),
        session_blob: null,
        updated_at: isoNow(this.clock),
      })
      .where("id", "=", id)
      .execute();
    await this.setState(id, "ok", null);
    await this.requestRun(id);
  }

  async updateSettings(
    id: string,
    changes: { label?: string; config?: unknown; enabled?: boolean },
  ): Promise<ConnectionView | undefined> {
    const row = await this.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    const config =
      changes.config === undefined
        ? undefined
        : JSON.stringify(this.#validateChange(row, changes.config));
    await this.db
      .updateTable("connections")
      .set({
        ...(changes.label === undefined ? {} : { label: changes.label }),
        ...(config === undefined ? {} : { config }),
        updated_at: isoNow(this.clock),
      })
      .where("id", "=", id)
      .execute();
    const labelChanged = changes.label !== undefined && changes.label !== row.label;
    if (labelChanged || (config !== undefined && config !== row.config)) {
      await this.#announceConnection(id, "connection.updated");
    }
    if (changes.enabled === false) {
      await this.setState(id, "disabled", null);
    } else if (changes.enabled === true && row.state === "disabled") {
      await this.#enable(row);
    }
    return this.get(id);
  }

  /**
   * Re-enables a disabled connection without claiming more than is known: one that never ran
   * successfully says "not run yet" instead of a bare OK. It is due at once, so a run decides
   * (and a run without any stored sign-in reports "not signed in yet").
   */
  async #enable(row: ConnectionRow): Promise<void> {
    const proven = row.last_ok_at !== null || row.kind === "mail";
    await this.setState(row.id, "ok", proven ? null : NOT_RUN_YET);
    if (row.kind !== "mail") {
      await this.requestRun(row.id);
    }
  }

  /** Deletes the connection and fires `connection.removed`, so clients drop its device at once. */
  async delete(id: string): Promise<boolean> {
    const deleted = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("connections")
        .select(["id", "provider", "label", "kind"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (row === undefined) {
        return false;
      }
      await trx.deleteFrom("connections").where("id", "=", id).execute();
      await appendConnectionRemoved(trx, this.clock, row, null);
      return true;
    });
    if (deleted) {
      await this.bus.notify();
    }
    return deleted;
  }

  /**
   * Fires `connection.run_finished`: a run ended, whatever its outcome. It carries the connection's
   * current label, state and detail, so a client that missed a change catches up here.
   */
  async announceRun(id: string, ok: boolean): Promise<void> {
    const row = await this.#eventRow(id);
    if (row === undefined) {
      return;
    }
    await appendEvent(this.db, this.clock, {
      type: "connection.run_finished",
      parcelId: null,
      payload: { ...connectionPayload(row), ok },
    });
    await this.bus.notify();
  }

  /** Fires `connection.added` or `connection.updated` with the connection as it now is. */
  async #announceConnection(
    id: string,
    type: "connection.added" | "connection.updated",
  ): Promise<void> {
    const row = await this.#eventRow(id);
    if (row === undefined) {
      return;
    }
    await appendEvent(this.db, this.clock, {
      type,
      parcelId: null,
      payload: connectionPayload(row),
    });
    await this.bus.notify();
  }

  async #eventRow(id: string): Promise<EventRow | undefined> {
    return this.db
      .selectFrom("connections")
      .select(["id", "provider", "label", "kind", "state", "state_detail"])
      .where("id", "=", id)
      .executeTakeFirst();
  }

  /**
   * Asks the scheduler to run this connection as soon as possible, but never before its backoff ends:
   * a captcha pause or a carrier's 429 is honoured whoever asks. Returns the time the run was
   * deferred to, or null when it is due now.
   */
  async requestRun(id: string): Promise<{ deferredUntil: string | null }> {
    const row = await this.db
      .selectFrom("connections")
      .select("backoff_until")
      .where("id", "=", id)
      .executeTakeFirst();
    const now = this.clock.now().getTime();
    const until = row?.backoff_until ?? null;
    const backoff = until === null ? Number.NaN : Date.parse(until);
    const deferredUntil =
      Number.isFinite(backoff) && backoff > now ? new Date(backoff).toISOString() : null;
    await this.db
      .updateTable("connections")
      .set({ next_run_at: deferredUntil ?? isoNow(this.clock) })
      .where("id", "=", id)
      .execute();
    return { deferredUntil };
  }

  /** Changes the state and fires `connection.state_changed` when it actually changed. */
  async setState(id: string, state: ConnectionState, detail: string | null): Promise<void> {
    const row = await this.db
      .selectFrom("connections")
      .select(["state", "provider", "label"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      return;
    }
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("connections")
        .set({ state, state_detail: detail, updated_at: isoNow(this.clock) })
        .where("id", "=", id)
        .execute();
      if (row.state !== state) {
        await appendEvent(trx, this.clock, {
          type: "connection.state_changed",
          parcelId: null,
          payload: {
            connection: { id, provider: row.provider, label: row.label },
            old_state: row.state,
            new_state: state,
            detail,
          },
        });
      }
    });
    await this.bus.notify();
  }
}
