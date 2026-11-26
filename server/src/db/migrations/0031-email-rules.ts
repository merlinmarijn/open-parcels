import type { Kysely } from "kysely";

/**
 * `email_rules`: the owner's own email rules, written in the email lab (`docs/email-lab.md`). Each
 * row holds one rule in the rules' email rule format (`EmailRuleDefinition`) as JSON; inboxes read
 * with them in addition to the shared and the providers' email rules.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("email_rules")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("definition", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();
}
