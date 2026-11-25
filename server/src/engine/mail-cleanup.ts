import type { Kysely } from "kysely";
import {
  findCarrier,
  ignoredEmail,
  isBoilerplateItemTitle,
  plausibleEmailTrackingNumber,
  type Rules,
} from "open-parcels-rules";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { linkedToKind } from "../db/visibility.js";
import { appendParcelEvents } from "./repair-events.js";

/** Settings key that marks the one-off cleanup as done. */
const MAIL_CLEANUP_KEY = "cleanup.mail-false-positives.v1";

type MailCleanupReason = "placeholder_or_pattern" | "ignored_mail";

export interface MailCleanupResult {
  /** False when an earlier start already ran it. */
  readonly ran: boolean;
  readonly archived: Readonly<Record<MailCleanupReason, number>>;
  readonly boilerplateItemsRemoved: number;
}

interface Candidate {
  readonly id: string;
  readonly carrier: string;
  readonly trackingNumber: string;
  readonly subjects: readonly string[];
}

/** The mail subject was kept as raw status; an ignore rule for the carrier's domains decides. */
function ignoredSubject(rules: Rules, candidate: Candidate): boolean {
  const domains = findCarrier(rules, candidate.carrier)?.domains ?? [];
  return candidate.subjects.some((subject) =>
    domains.some((domain) => ignoredEmail(rules, `noreply@${domain}`, subject)),
  );
}

function cleanupReason(rules: Rules, candidate: Candidate): MailCleanupReason | null {
  if (!plausibleEmailTrackingNumber(rules, candidate.carrier, candidate.trackingNumber)) {
    return "placeholder_or_pattern";
  }
  return ignoredSubject(rules, candidate) ? "ignored_mail" : null;
}

/** Active parcels that only mails know about and that no carrier ever found. */
async function candidates(db: Kysely<Database>): Promise<Candidate[]> {
  const rows = await db
    .selectFrom("parcels")
    .select(["id", "carrier", "tracking_number", "raw_status"])
    .where("archived_at", "is", null)
    .where("removed_at", "is", null)
    .where("lookup_state", "!=", "found")
    .where("manual_status", "is", null)
    // A mail made it; no account or shop lists it. The carrier's tracking connection, which startup
    // repair links to every parcel, counts only through lookup_state.
    .where((eb) =>
      eb.and([linkedToKind(eb, ["mail"]), eb.not(linkedToKind(eb, ["account", "shop"]))]),
    )
    .execute();
  if (rows.length === 0) return [];
  const events = await db
    .selectFrom("parcel_events")
    .select(["parcel_id", "raw_status"])
    .where(
      "parcel_id",
      "in",
      rows.map((row) => row.id),
    )
    .execute();
  return rows.map((row) => ({
    id: row.id,
    carrier: row.carrier,
    trackingNumber: row.tracking_number,
    subjects: [
      ...(row.raw_status === null ? [] : [row.raw_status]),
      ...events.filter((event) => event.parcel_id === row.id).map((event) => event.raw_status),
    ],
  }));
}

/**
 * One-off and idempotent: archives (never deletes) parcels that earlier, looser mail rules made
 * from mails that were not shipments, records why in `archive_reason`, and drops item titles
 * that were instructions, firing `parcel.archived` for each parcel it archives. Marks itself done
 * in the settings table so later starts skip it.
 */
export async function cleanupMailFalsePositives(
  db: Kysely<Database>,
  clock: Clock,
  rules: Rules,
): Promise<MailCleanupResult> {
  const archived: Record<MailCleanupReason, number> = {
    placeholder_or_pattern: 0,
    ignored_mail: 0,
  };
  const done = await db
    .selectFrom("settings")
    .select("key")
    .where("key", "=", MAIL_CLEANUP_KEY)
    .executeTakeFirst();
  if (done !== undefined) {
    return { ran: false, archived, boilerplateItemsRemoved: 0 };
  }
  const now = isoNow(clock);
  const found = await candidates(db);
  const items = await db.selectFrom("items").select(["id", "title"]).execute();
  const boilerplate = items.filter((item) => isBoilerplateItemTitle(item.title)).map((i) => i.id);
  await db.transaction().execute(async (trx) => {
    for (const candidate of found) {
      const reason = cleanupReason(rules, candidate);
      if (reason === null) continue;
      archived[reason] += 1;
      const updated = await trx
        .updateTable("parcels")
        .set({ archived_at: now, archive_reason: `mail-cleanup: ${reason}`, updated_at: now })
        .where("id", "=", candidate.id)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      if (updated.numUpdatedRows > 0n) {
        await appendParcelEvents(trx, clock, "parcel.archived", [candidate.id]);
      }
    }
    if (boilerplate.length > 0) {
      await trx.deleteFrom("items").where("id", "in", boilerplate).execute();
    }
    await trx
      .insertInto("settings")
      .values({ key: MAIL_CLEANUP_KEY, value: JSON.stringify({ at: now }), updated_at: now })
      .onConflict((oc) => oc.column("key").doNothing())
      .execute();
  });
  return { ran: true, archived, boilerplateItemsRemoved: boilerplate.length };
}
