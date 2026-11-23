import { sql, type Kysely } from "kysely";

/**
 * `manual_at`: when the owner set the current manual status. A parcel marked delivered by hand has
 * no carrier delivery time, so retention, the calendar and polling read its delivery time from
 * here. Existing manual statuses take the parcel's last change as their best guess.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("parcels").addColumn("manual_at", "text").execute();
  await sql`update parcels set manual_at = updated_at where manual_status is not null`.execute(db);
}
