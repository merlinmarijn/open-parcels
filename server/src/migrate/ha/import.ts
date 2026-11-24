import { createHash, createHmac } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { z } from "zod";
import { isoNow, type Clock } from "../../clock.js";
import type { SecretBox } from "../../crypto/secrets.js";
import type { Database } from "../../db/schema.js";
import { normaliseTrackingNumber } from "../../engine/tracking-number.js";
import { BUILTIN_CARRIERS } from "../../engine/builtin-carriers.js";
import { trackingConnectionIn } from "../../engine/linking.js";
import { InvalidConnectionConfigError, ProviderRegistry } from "../../engine/registry.js";
import { configKey } from "../../engine/connection-dedup.js";
import { NOT_RUN_YET, secretAad, sessionAad } from "../../engine/connections.js";
import { appendEvent } from "../../events/bus.js";
import { parseConfigEntries, planEntry, type ConnectionPlan } from "./entries.js";

/**
 * Imports the Home Assistant parcel suite's config entries as connections, signed in where the stored
 * tokens allow. Idempotent: each HA entry leaves a marker in `settings`, so a re-run updates the
 * connection it created instead of adding another. The report holds labels and counts, never secrets.
 */

export interface HaConnectionReport {
  readonly entryId: string;
  readonly domain: string;
  readonly label: string;
  readonly provider: string;
  readonly kind: string;
  readonly action: "created" | "updated";
  readonly state: "ok" | "needs_sign_in";
  readonly stateDetail: string | null;
  /** True when sign-in data was carried over (never the data itself). */
  readonly signedIn: boolean;
  /** False on a re-run whose HA sign-in data was unchanged, so newer tokens were kept. */
  readonly credentialsWritten: boolean;
  readonly parcels: number;
  readonly notCarriedOver: readonly string[];
}

export interface HaEntryNote {
  readonly entryId: string;
  readonly domain: string;
  readonly title: string;
  readonly reason: string;
}

export interface HaImportReport {
  readonly dryRun: boolean;
  readonly connections: readonly HaConnectionReport[];
  readonly parcels: { readonly created: number; readonly existing: number };
  readonly covered: readonly HaEntryNote[];
  readonly skipped: readonly HaEntryNote[];
  /** Entries of integrations this importer does not know, counted per domain. */
  readonly unrecognised: Readonly<Record<string, number>>;
}

export interface HaImportOptions {
  /** The parsed contents of HA's `.storage/core.config_entries`. */
  readonly configEntries: unknown;
  readonly db: Kysely<Database>;
  readonly secrets: SecretBox;
  readonly clock: Clock;
  readonly dryRun: boolean;
}

class DryRunRollback extends Error {
  override readonly name = "DryRunRollback";
}

export const markerKey = (entryId: string): string => `ha_import:${entryId}`;

/** `adopted`: the entry was mapped onto a connection that existed before; it is never rewritten. */
const markerSchema = z.object({
  connectionId: z.string(),
  credentials: z.string(),
  adopted: z.boolean().optional(),
});
type Marker = z.infer<typeof markerSchema>;

const credentialsJson = (plan: ConnectionPlan): string =>
  JSON.stringify({ secret: plan.secret, session: plan.session });

/**
 * A fingerprint of the sign-in data as HA had it, to tell a changed HA entry from a re-run.
 * Keyed with the instance's secret, so the stored value cannot be used to test guesses of a
 * password or token offline.
 */
function credentialsFingerprint(secrets: SecretBox, plan: ConnectionPlan): string {
  return createHmac("sha256", secrets.derive("ha-import"))
    .update(credentialsJson(plan))
    .digest("hex")
    .slice(0, 16);
}

/** The unkeyed fingerprint earlier versions stored; still recognised so a re-run keeps tokens. */
function legacyFingerprint(plan: ConnectionPlan): string {
  return createHash("sha256").update(credentialsJson(plan)).digest("hex").slice(0, 16);
}

async function readMarker(trx: Transaction<Database>, entryId: string): Promise<Marker | null> {
  const row = await trx
    .selectFrom("settings")
    .select("value")
    .where("key", "=", markerKey(entryId))
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(row.value);
  } catch {
    // A damaged marker only means the entry is treated as new.
    return null;
  }
  const parsed = markerSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

interface Context {
  readonly trx: Transaction<Database>;
  readonly secrets: SecretBox;
  readonly clock: Clock;
  readonly now: string;
}

async function writeMarker(ctx: Context, entryId: string, marker: Marker): Promise<void> {
  const value = JSON.stringify(marker);
  await ctx.trx
    .insertInto("settings")
    .values({ key: markerKey(entryId), value, updated_at: ctx.now })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: ctx.now }))
    .execute();
}

interface Written {
  readonly id: string;
  readonly action: "created" | "updated";
  readonly credentialsWritten: boolean;
}

function blobs(ctx: Context, id: string, plan: ConnectionPlan) {
  return {
    secret_blob: plan.secret === null ? null : ctx.secrets.encryptJson(plan.secret, secretAad(id)),
    session_blob:
      plan.session === null ? null : ctx.secrets.encryptJson(plan.session, sessionAad(id)),
    state: plan.state,
    state_detail: plan.stateDetail,
  };
}

/** Creates the plan's connection, or updates the one an earlier run created for the same HA entry. */
async function writeConnection(ctx: Context, plan: ConnectionPlan): Promise<Written> {
  const fingerprint = credentialsFingerprint(ctx.secrets, plan);
  const marker = await readMarker(ctx.trx, plan.entryId);
  const wanted = configKey(plan.config);
  const found =
    marker === null
      ? undefined
      : await ctx.trx
          .selectFrom("connections")
          .select(["id", "provider", "config"])
          .where("id", "=", marker.connectionId)
          .executeTakeFirst();
  // An adoption by an older version may have matched on the provider alone; one whose settings
  // differ from the entry's is dropped, so the entry gets a connection of its own.
  const existing =
    marker?.adopted === true && found !== undefined && configKey(found.config) !== wanted
      ? undefined
      : found;
  if (marker?.adopted === true && existing?.provider === plan.provider) {
    return { id: existing.id, action: "updated", credentialsWritten: false };
  }
  // A keyless tracking connection holds nothing of its own beyond its settings: adopt the provider's
  // existing one with the same settings (created on first use, say) instead of adding a second,
  // keeping that connection's id and label.
  const adopted =
    existing === undefined && plan.kind === "tracking" && plan.secret === null
      ? (
          await ctx.trx
            .selectFrom("connections")
            .select(["id", "provider", "config"])
            .where("provider", "=", plan.provider)
            .where("kind", "=", "tracking")
            .where("secret_blob", "is", null)
            .orderBy("created_at")
            .execute()
        ).find((connection) => configKey(connection.config) === wanted)
      : undefined;
  if (adopted !== undefined) {
    await writeMarker(ctx, plan.entryId, {
      connectionId: adopted.id,
      credentials: fingerprint,
      adopted: true,
    });
    return { id: adopted.id, action: "updated", credentialsWritten: false };
  }
  if (marker !== null && existing?.provider === plan.provider) {
    // Same HA sign-in as last time: the connection may have rotated its tokens since, so keep them.
    const fresh =
      marker.credentials !== fingerprint && marker.credentials !== legacyFingerprint(plan);
    await ctx.trx
      .updateTable("connections")
      .set({
        label: plan.label,
        config: JSON.stringify(plan.config),
        ...(fresh ? { ...blobs(ctx, existing.id, plan), next_run_at: ctx.now } : {}),
        updated_at: ctx.now,
      })
      .where("id", "=", existing.id)
      .execute();
    await writeMarker(ctx, plan.entryId, { connectionId: existing.id, credentials: fingerprint });
    return { id: existing.id, action: "updated", credentialsWritten: fresh };
  }
  const id = crypto.randomUUID();
  const written = blobs(ctx, id, plan);
  // As ConnectionService.create: nothing has run yet, and that is what the connection says.
  const detail =
    written.state === "ok" ? (written.state_detail ?? NOT_RUN_YET) : written.state_detail;
  await ctx.trx
    .insertInto("connections")
    .values({
      id,
      provider: plan.provider,
      kind: plan.kind,
      label: plan.label,
      config: JSON.stringify(plan.config),
      ...written,
      state_detail: detail,
      next_run_at: plan.state === "ok" ? ctx.now : null,
      created_at: ctx.now,
      updated_at: ctx.now,
    })
    .execute();
  // Clients add the connection's device when the running server next delivers events.
  await appendEvent(ctx.trx, ctx.clock, {
    type: "connection.added",
    parcelId: null,
    payload: {
      connection: { id, provider: plan.provider, label: plan.label, kind: plan.kind },
      state: plan.state,
      detail,
    },
  });
  await writeMarker(ctx, plan.entryId, { connectionId: id, credentials: fingerprint });
  return { id, action: "created", credentialsWritten: true };
}

interface ParcelCounts {
  created: number;
  existing: number;
}

/** Adds the codes as parcels (once per carrier and code) and links them to `connectionId`. */
async function writeParcels(
  ctx: Context,
  plan: ConnectionPlan,
  connectionId: string,
  counts: ParcelCounts,
): Promise<void> {
  for (const given of plan.parcels) {
    const parcel = {
      ...given,
      trackingNumber: normaliseTrackingNumber(plan.provider, given.trackingNumber),
    };
    // Removed parcels count too: the table holds one row per carrier and code, and HA still
    // tracking the code means it is not gone, so a removed one is revived.
    const found = await ctx.trx
      .selectFrom("parcels")
      .select(["id", "removed_at"])
      .where("carrier", "=", plan.provider)
      .where("tracking_number", "=", parcel.trackingNumber)
      .executeTakeFirst();
    if (found !== undefined && found.removed_at !== null) {
      await ctx.trx
        .updateTable("parcels")
        .set({ removed_at: null, updated_at: ctx.now })
        .where("id", "=", found.id)
        .execute();
    }
    const id = found?.id ?? crypto.randomUUID();
    if (found === undefined) {
      await ctx.trx
        .insertInto("parcels")
        .values({
          id,
          carrier: plan.provider,
          tracking_number: parcel.trackingNumber,
          direction: parcel.direction,
          status: "unknown",
          raw_status: null,
          delivered: 0,
          delivered_at: null,
          expected_from: null,
          expected_to: null,
          pickup: 0,
          label: null,
          order_id: null,
          manual_status: null,
          first_seen_at: ctx.now,
          last_seen_at: ctx.now,
          updated_at: ctx.now,
        })
        .execute();
      counts.created += 1;
    } else {
      counts.existing += 1;
    }
    await ctx.trx
      .insertInto("parcel_connections")
      .values({
        parcel_id: id,
        connection_id: connectionId,
        external_ref: null,
        role: "primary",
        last_seen_at: ctx.now,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

function note(entry: { entryId: string; domain: string; title: string }, reason: string) {
  return { entryId: entry.entryId, domain: entry.domain, title: entry.title, reason };
}

const REGISTRY = new ProviderRegistry(BUILTIN_CARRIERS);

/**
 * Why a planned connection would not work, checked against its provider's own schemas as
 * ConnectionService.create does; null when it fits. Reported as skipped instead of an import that
 * says "ok" and fails on its first run.
 */
function planProblem(plan: ConnectionPlan): string | null {
  const provider = REGISTRY.get(plan.provider);
  if (provider === undefined) {
    return `There is no carrier provider called ${plan.provider}.`;
  }
  try {
    provider.validateConfig(plan.config);
  } catch (error) {
    if (error instanceof InvalidConnectionConfigError) {
      return error.message;
    }
    throw error;
  }
  if (plan.secret !== null && !provider.info.secretSchema.safeParse(plan.secret).success) {
    return `The sign-in data does not fit ${provider.info.name}.`;
  }
  return null;
}

/** Tracking entries first, so DHL account codes go to the imported "DHL tracking" connection. */
function order(plans: readonly ConnectionPlan[]): ConnectionPlan[] {
  return [...plans].sort((a, b) => Number(b.kind === "tracking") - Number(a.kind === "tracking"));
}

async function importPlans(
  trx: Transaction<Database>,
  options: HaImportOptions,
  plans: readonly ConnectionPlan[],
  counts: ParcelCounts,
): Promise<HaConnectionReport[]> {
  const ctx: Context = {
    trx,
    secrets: options.secrets,
    clock: options.clock,
    now: isoNow(options.clock),
  };
  const trackingFor = trackingConnectionIn(trx, REGISTRY, options.clock);
  let dhlTracking: string | undefined;
  const reports: HaConnectionReport[] = [];
  for (const plan of order(plans)) {
    const written = await writeConnection(ctx, plan);
    if (plan.provider === "dhl" && plan.kind === "tracking") {
      dhlTracking ??= written.id;
    }
    if (plan.parcels.length > 0) {
      const target =
        plan.parcelTarget === "self" ? written.id : (dhlTracking ??= await trackingFor("dhl"));
      if (target !== undefined) {
        await writeParcels(ctx, plan, target, counts);
      }
    }
    reports.push({
      entryId: plan.entryId,
      domain: plan.domain,
      label: plan.label,
      provider: plan.provider,
      kind: plan.kind,
      action: written.action,
      state: plan.state,
      stateDetail: plan.stateDetail,
      signedIn: plan.state === "ok" && (plan.secret !== null || plan.session !== null),
      credentialsWritten: written.credentialsWritten,
      parcels: plan.parcels.length,
      notCarriedOver: plan.notCarriedOver,
    });
  }
  return reports;
}

/**
 * Runs the import. A dry run does the whole import in a transaction and rolls it back, so it
 * checks everything it would write.
 */
export async function importHaEntries(options: HaImportOptions): Promise<HaImportReport> {
  const plans: ConnectionPlan[] = [];
  const covered: HaEntryNote[] = [];
  const skipped: HaEntryNote[] = [];
  const unrecognised: Record<string, number> = {};
  for (const entry of parseConfigEntries(options.configEntries)) {
    const plan = planEntry(entry);
    if (plan.type === "connection") {
      const problem = planProblem(plan.plan);
      if (problem === null) {
        plans.push(plan.plan);
      } else {
        skipped.push(note(entry, problem));
      }
    } else if (plan.type === "covered") {
      covered.push(note(entry, plan.reason));
    } else if (plan.type === "skipped") {
      skipped.push(note(entry, plan.reason));
    } else {
      unrecognised[entry.domain] = (unrecognised[entry.domain] ?? 0) + 1;
    }
  }
  const counts: ParcelCounts = { created: 0, existing: 0 };
  let connections: HaConnectionReport[] = [];
  try {
    await options.db.transaction().execute(async (trx) => {
      connections = await importPlans(trx, options, plans, counts);
      if (options.dryRun) {
        throw new DryRunRollback("Dry run: rolling back.");
      }
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) {
      throw error;
    }
  }
  return {
    dryRun: options.dryRun,
    connections,
    parcels: counts,
    covered,
    skipped,
    unrecognised,
  };
}
