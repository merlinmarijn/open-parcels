import { sql, type Kysely } from "kysely";
import { inTransaction } from "../atomic.js";

/** Stored English texts the engine wrote, and the reason code each one is now. */
const EXACT: readonly (readonly [string, string])[] = [
  ["Not run yet.", "not_run_yet"],
  ["Not signed in yet.", "not_signed_in_yet"],
  ["The carrier rejected the sign-in. Sign in again.", "sign_in_rejected"],
  [
    "The stored sign-in could not be decrypted (was the encryption key changed?). Sign in again.",
    "sign_in_unreadable",
  ],
  ["The stored sign-in could not be read. Enter the password again.", "sign_in_unreadable"],
  ["The carrier asked us to slow down.", "rate_limited"],
  ["The carrier showed a captcha; paused for six hours.", "captcha"],
  ["The connection's carrier provider is not installed.", "provider_missing"],
  ["The last update failed; retrying later.", "update_failed"],
  ["The mail server rejected the sign-in. Enter the password again.", "inbox_sign_in_rejected"],
  ["The inbox settings are invalid.", "inbox_settings_invalid"],
  ["The mail server could not be reached; retrying.", "inbox_unreachable"],
];

/** "The last update failed: <what the provider said> Retrying later." */
const FAILED_PREFIX = "The last update failed: ";
const FAILED_SUFFIX = " Retrying later.";

/**
 * `connections.state_detail` (English text) becomes `state_reason` (a code clients translate) and
 * `carrier_message` (a provider's or carrier's own words, passed through). Known texts map to their
 * code; the provider's part of "The last update failed: … Retrying later." moves to
 * `carrier_message`. Any other text was written by a provider: on an `idle` connection it is why
 * the provider did nothing, on an `error` one its settings complaint, on a `needs_sign_in` one an
 * import note from Home Assistant. Stored live events carry the old payload, so the outbox is
 * emptied (clients resync once). The backup result kept in settings has its error text replaced
 * by the general code `failed`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await inTransaction(db, async () => {
    await db.schema.alterTable("connections").addColumn("state_reason", "text").execute();
    await db.schema.alterTable("connections").addColumn("carrier_message", "text").execute();
    for (const [text, code] of EXACT) {
      await sql`
        update connections set state_reason = ${code} where state_detail = ${text}
      `.execute(db);
    }
    await sql`
      update connections
      set state_reason = 'update_failed',
          carrier_message = substr(
            state_detail,
            ${FAILED_PREFIX.length + 1},
            length(state_detail) - ${FAILED_PREFIX.length + FAILED_SUFFIX.length}
          )
      where state_reason is null
        and state_detail like ${`${FAILED_PREFIX}%${FAILED_SUFFIX}`}
    `.execute(db);
    await sql`
      update connections
      set state_reason = case state
            when 'idle' then 'provider_idle'
            when 'error' then 'invalid_config'
            when 'needs_sign_in' then 'imported_without_sign_in'
          end,
          carrier_message = case when state = 'needs_sign_in' then null else state_detail end
      where state_reason is null and state_detail is not null
        and state in ('idle', 'error', 'needs_sign_in')
    `.execute(db);
    await db.schema.alterTable("connections").dropColumn("state_detail").execute();

    await sql`
      update settings
      set value = json_set(value, '$.error', 'failed')
      where key = 'backup_last' and json_extract(value, '$.error') is not null
    `.execute(db);
    await sql`delete from outbox`.execute(db);
  });
}
