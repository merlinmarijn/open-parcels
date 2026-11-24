import type { Kysely } from "kysely";
import { z } from "zod";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { appendEvent, type EventBus } from "../events/bus.js";
import { PARCEL_LABEL_MODES, type ParcelLabelMode } from "../domain/parcel.js";

export const homeSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    label: z.string().trim().max(300).nullable().default(null),
  })
  .describe("Where parcels go: centres the maps and gives distances. Set by the user.");
export type Home = z.infer<typeof homeSchema>;

const HOME = "home";
const PARCEL_LABEL = "parcel_label";
const READER_NOTICE = "reader_password_notice_dismissed";
const FEED_HASH = "calendar_feed_token_hash";
const INSTALL_ID = "install_id";
const labelSchema = z.enum(PARCEL_LABEL_MODES);

/**
 * The app's settings, kept in memory and written through to the `settings` table. Parcel reads use the label mode on every row, so it must not cost a query.
 */
export class SettingsStore {
  #home: Home | null = null;
  #labelMode: ParcelLabelMode = "tracking_number";
  #readerNoticeDismissed = false;
  #feedHash: string | null = null;
  #installId: string | null = null;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly bus: EventBus,
  ) {}

  async load(): Promise<void> {
    const rows = await this.db.selectFrom("settings").select(["key", "value"]).execute();
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const read = <T>(key: string, schema: z.ZodType<T>): T | undefined => {
      const raw = values.get(key);
      if (raw === undefined) return undefined;
      const parsed = schema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    };
    this.#home = read(HOME, homeSchema) ?? null;
    this.#labelMode = read(PARCEL_LABEL, labelSchema) ?? "tracking_number";
    this.#readerNoticeDismissed = read(READER_NOTICE, z.literal(true)) ?? false;
    this.#feedHash = read(FEED_HASH, z.string()) ?? null;
    this.#installId = read(INSTALL_ID, z.string()) ?? null;
  }

  /** A random id per installation, stored once; it spreads polling of different installs apart. */
  async installId(): Promise<string> {
    if (this.#installId === null) {
      const id = crypto.randomUUID();
      await this.#write(INSTALL_ID, id);
      this.#installId = id;
    }
    return this.#installId;
  }

  /** The SHA-256 of the secret in the ICS feed address; null while the feed is off. */
  get feedHash(): string | null {
    return this.#feedHash;
  }

  async setFeedHash(hash: string | null): Promise<void> {
    await this.#write(FEED_HASH, hash);
    this.#feedHash = hash;
  }

  /** Fires `settings.updated`: every parcel's display name may change, clients re-read. */
  async announce(changed: string): Promise<void> {
    await appendEvent(this.db, this.clock, {
      type: "settings.updated",
      parcelId: null,
      payload: { changed },
    });
    await this.bus.notify();
  }

  get home(): Home | null {
    return this.#home;
  }

  get labelMode(): ParcelLabelMode {
    return this.#labelMode;
  }

  /** The admin dismissed the "no reader password" notice; kept here so every browser knows. */
  get readerNoticeDismissed(): boolean {
    return this.#readerNoticeDismissed;
  }

  async dismissReaderNotice(): Promise<void> {
    await this.#write(READER_NOTICE, true);
    this.#readerNoticeDismissed = true;
  }

  async setHome(home: Home | null): Promise<void> {
    await this.#write(HOME, home);
    this.#home = home;
    await this.announce("home");
  }

  async setLabelMode(mode: ParcelLabelMode): Promise<void> {
    await this.#write(PARCEL_LABEL, mode === "tracking_number" ? null : mode);
    this.#labelMode = mode;
    await this.announce("parcel_label");
  }

  async #write(key: string, value: unknown): Promise<void> {
    if (value === null) {
      await this.db.deleteFrom("settings").where("key", "=", key).execute();
      return;
    }
    const now = isoNow(this.clock);
    const json = JSON.stringify(value);
    await this.db
      .insertInto("settings")
      .values({ key, value: json, updated_at: now })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: json, updated_at: now }))
      .execute();
  }
}
