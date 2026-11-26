import type { Kysely } from "kysely";
import type { EmailRuleDefinition } from "open-parcels-rules";
import type { Logger } from "pino";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import type { EmailRuleReader, RuleProblem } from "./rule-reader.js";

/** A custom email rule as stored. */
export interface CustomEmailRule {
  readonly id: string;
  readonly definition: EmailRuleDefinition;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class InvalidEmailRuleError extends Error {
  override readonly name = "InvalidEmailRuleError";

  constructor(readonly problems: readonly RuleProblem[]) {
    super(problems.map((problem) => problem.message).join("; "));
  }
}

/**
 * The owner's own email rules (`docs/email-lab.md`), stored in `email_rules` and read by every
 * inbox next to the shared and the providers' email rules. Saving one applies to the next email;
 * mails read before are read again with the email lab's re-read.
 */
export class CustomEmailRules {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly reader: EmailRuleReader,
    /** Ids of the shared and providers' email rules, which a custom rule may not take. */
    private readonly reserved: () => ReadonlySet<string>,
    private readonly logger: Logger,
  ) {}

  /** Hands the stored rules to the reader; one that no longer passes (newer rules) is skipped. */
  async load(): Promise<void> {
    const rules = await this.list();
    const problems = this.check(rules.map((rule) => rule.definition));
    const bad = new Set(problems.map((problem) => problem.index));
    if (bad.size > 0) {
      this.logger.warn(
        { rules: rules.filter((_, index) => bad.has(index)).map((rule) => rule.id) },
        "Custom email rules that no longer match the email rule schema are skipped.",
      );
    }
    this.reader.setCustom(
      rules.filter((_, index) => !bad.has(index)).map((rule) => rule.definition),
    );
  }

  async list(): Promise<CustomEmailRule[]> {
    const rows = await this.db.selectFrom("email_rules").selectAll().orderBy("id").execute();
    return rows.map((row) => ({
      id: row.id,
      // Checked against the schema when saved; `load` checks it again against the rules in use.
      definition: JSON.parse(row.definition) as EmailRuleDefinition,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** What is wrong with candidate rules (schema, regular expressions, ids); empty when nothing. */
  check(definitions: readonly unknown[]): RuleProblem[] {
    return this.reader.problems(definitions, this.reserved());
  }

  /** Creates or replaces the rule `id`; throws `InvalidEmailRuleError` when it cannot be used. */
  async put(id: string, definition: unknown): Promise<CustomEmailRule> {
    const problems = this.check([definition]);
    const named =
      typeof definition === "object" && definition !== null && "id" in definition
        ? definition.id
        : undefined;
    if (problems.length === 0 && named !== id) {
      problems.push({ index: 0, id, message: `The rule's id must be "${id}", as in the path.` });
    }
    if (problems.length > 0) throw new InvalidEmailRuleError(problems);
    const now = isoNow(this.clock);
    await this.db
      .insertInto("email_rules")
      .values({ id, definition: JSON.stringify(definition), created_at: now, updated_at: now })
      .onConflict((conflict) =>
        conflict
          .column("id")
          .doUpdateSet({ definition: JSON.stringify(definition), updated_at: now }),
      )
      .execute();
    await this.load();
    const saved = (await this.list()).find((rule) => rule.id === id);
    if (saved === undefined) throw new Error("The saved email rule is missing.");
    return saved;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom("email_rules").where("id", "=", id).executeTakeFirst();
    await this.load();
    return result.numDeletedRows > 0n;
  }
}
