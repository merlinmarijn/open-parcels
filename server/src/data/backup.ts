import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { appendEvent, type EventBus } from "../events/bus.js";

const HOUR_MS = 60 * 60 * 1000;
/**
 * Maintenance looks for a due backup once an hour, so a backup taken a little after the hour must
 * not wait a whole extra hour the next time round.
 */
const DUE_SLACK_MS = 5 * 60 * 1000;
/** A scheduled backup this much later than due means the schedule is not keeping up. */
const OVERDUE_GRACE_MS = 2 * HOUR_MS;

/** Why a backup was taken: by the schedule, by the admin, or before "Delete everything". */
export const BACKUP_REASONS = ["scheduled", "manual", "before_delete"] as const;
export type BackupReason = (typeof BACKUP_REASONS)[number];

/** Backups are named by their UTC time, so names sort by age: `openparcels-2026-11-25T10-00-00-000Z.db`. */
const FILE_PATTERN = /^openparcels-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db$/;
const LAST_RESULT_KEY = "backup_last";

export const backupResultSchema = z.object({
  ok: z.boolean(),
  reason: z.enum(BACKUP_REASONS),
  at: z.string(),
  file: z.string().nullable().describe("File name inside the backup folder; null on failure."),
  bytes: z.number().int().nullable(),
  error: z.string().nullable().describe("Why the backup failed; null on success."),
  pruned: z.number().int().describe("Older backups deleted to keep the configured number."),
});
export type BackupResult = z.infer<typeof backupResultSchema>;

export interface BackupFile {
  readonly name: string;
  readonly bytes: number;
  readonly created_at: string;
}

export interface BackupStatus {
  readonly interval_hours: number;
  readonly keep: number;
  readonly directory: string;
  readonly last: BackupResult | null;
  /** When the schedule takes the next backup; null when automatic backups are off. */
  readonly next_at: string | null;
  /** Automatic backups are on and the last one failed, or none succeeded for too long. */
  readonly failing: boolean;
  /** Newest first; empty when the folder cannot be read (the last result then says why). */
  readonly files: BackupFile[];
}

export interface BackupSettings {
  readonly intervalHours: number;
  readonly keep: number;
  readonly directory: string;
}

export interface BackupDeps {
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly bus: EventBus;
  /** Read on every use, so a change on the Settings page applies at once. */
  readonly settings: () => BackupSettings;
}

function fileName(at: Date): string {
  return `openparcels-${at.toISOString().replaceAll(":", "-").replace(".", "-")}.db`;
}

/** The time in a backup's name; undefined for files that are not backups. */
function takenAt(name: string): Date | undefined {
  const match = FILE_PATTERN.exec(name);
  if (match === null) return undefined;
  const [, day, hours, minutes, seconds, millis] = match;
  return new Date(`${day ?? ""}T${hours ?? ""}:${minutes ?? ""}:${seconds ?? ""}.${millis ?? ""}Z`);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** The backups in `directory`, newest first; none when the folder does not exist yet. */
export async function listBackups(directory: string): Promise<BackupFile[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files: BackupFile[] = [];
  for (const name of names.sort().reverse()) {
    const at = takenAt(name);
    if (at === undefined) continue;
    const info = await stat(path.join(directory, name));
    if (info.isFile()) {
      files.push({ name, bytes: info.size, created_at: at.toISOString() });
    }
  }
  return files;
}

/**
 * Scheduled and on-demand copies of the database. Each backup is SQLite's `VACUUM INTO`, which
 * reads one consistent snapshot while the server keeps writing, into a `.partial` file that is
 * renamed only when complete; so a backup in the folder is always whole. Backups run one at a
 * time. Every result is kept in the settings table and announced as the live event
 * `backup.finished`.
 */
export class BackupService {
  #queue: Promise<unknown> = Promise.resolve();
  #last: BackupResult | null | undefined;

  constructor(private readonly deps: BackupDeps) {}

  /** Takes a backup now. A failed backup is reported in the result, not thrown. */
  run(reason: BackupReason): Promise<BackupResult> {
    const turn = this.#queue.then(() => this.#run(reason));
    this.#queue = turn.catch(() => undefined);
    return turn;
  }

  /** Takes a scheduled backup when automatic backups are on and the newest one is old enough. */
  async runIfDue(): Promise<BackupResult | null> {
    const settings = this.deps.settings();
    const due = await this.#dueAt(settings);
    if (due === null || due.getTime() - DUE_SLACK_MS > this.deps.clock.now().getTime()) {
      return null;
    }
    return this.run("scheduled");
  }

  async status(): Promise<BackupStatus> {
    const settings = this.deps.settings();
    const files = await this.#files(settings.directory);
    const last = await this.#lastResult();
    const due = await this.#dueAt(settings, files);
    const now = this.deps.clock.now().getTime();
    const overdue = due !== null && files.length > 0 && now - due.getTime() > OVERDUE_GRACE_MS;
    return {
      interval_hours: settings.intervalHours,
      keep: settings.keep,
      directory: settings.directory,
      last,
      next_at: due === null ? null : new Date(Math.max(due.getTime(), now)).toISOString(),
      failing: settings.intervalHours > 0 && (last?.ok === false || overdue),
      files,
    };
  }

  /** When the next scheduled backup is due: now when there is none yet; null when off. */
  async #dueAt(settings: BackupSettings, known?: readonly BackupFile[]): Promise<Date | null> {
    if (settings.intervalHours === 0) return null;
    const files = known ?? (await this.#files(settings.directory));
    const newest = files[0];
    if (newest === undefined) return this.deps.clock.now();
    return new Date(Date.parse(newest.created_at) + settings.intervalHours * HOUR_MS);
  }

  /**
   * The backups in the folder; none when it cannot be read, so a schedule pointed at a broken
   * folder still tries, and records why it fails, instead of stopping silently.
   */
  async #files(directory: string): Promise<BackupFile[]> {
    try {
      return await listBackups(directory);
    } catch (error) {
      this.deps.logger.debug({ err: error }, "The backup folder could not be read.");
      return [];
    }
  }

  async #run(reason: BackupReason): Promise<BackupResult> {
    const { directory, keep } = this.deps.settings();
    const at = this.deps.clock.now();
    const name = fileName(at);
    const target = path.join(directory, name);
    const partial = `${target}.partial`;
    let result: BackupResult;
    try {
      await mkdir(directory, { recursive: true });
      await rm(partial, { force: true });
      await sql`vacuum into ${partial}`.execute(this.deps.db);
      await rename(partial, target);
      const bytes = (await stat(target)).size;
      const pruned = await this.#prune(directory, keep);
      result = { ok: true, reason, at: at.toISOString(), file: name, bytes, error: null, pruned };
      this.deps.logger.info({ reason, file: name, bytes, pruned }, "Database backup written.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        ok: false,
        reason,
        at: at.toISOString(),
        file: null,
        bytes: null,
        error: message,
        pruned: 0,
      };
      this.deps.logger.error({ err: error, reason }, "Database backup failed.");
      await rm(partial, { force: true }).catch((cleanup: unknown) => {
        this.deps.logger.warn({ err: cleanup }, "Removing an unfinished backup failed.");
      });
    }
    await this.#record(result);
    return result;
  }

  /** Deletes the oldest backups beyond `keep`; returns how many. */
  async #prune(directory: string, keep: number): Promise<number> {
    const stale = (await listBackups(directory)).slice(keep);
    for (const file of stale) {
      await rm(path.join(directory, file.name), { force: true });
    }
    return stale.length;
  }

  async #lastResult(): Promise<BackupResult | null> {
    if (this.#last === undefined) {
      const row = await this.deps.db
        .selectFrom("settings")
        .select("value")
        .where("key", "=", LAST_RESULT_KEY)
        .executeTakeFirst();
      const parsed =
        row === undefined ? undefined : backupResultSchema.safeParse(JSON.parse(row.value));
      this.#last = parsed?.success === true ? parsed.data : null;
    }
    return this.#last;
  }

  async #record(result: BackupResult): Promise<void> {
    this.#last = result;
    const now = isoNow(this.deps.clock);
    const value = JSON.stringify(result);
    await this.deps.db
      .insertInto("settings")
      .values({ key: LAST_RESULT_KEY, value, updated_at: now })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now }))
      .execute();
    await appendEvent(this.deps.db, this.deps.clock, {
      type: "backup.finished",
      parcelId: null,
      payload: result,
    });
    await this.deps.bus.notify();
  }
}
