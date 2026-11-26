import { withEmailRules, type EmailRuleDefinition, type Rules } from "open-parcels-rules";
import { createMailInterpreter, createOrderInterpreter } from "./interpret.js";
import { createReturnInterpreter } from "./returns.js";
import type {
  MailInput,
  MailInterpreter,
  MailOrderInterpreter,
  MailReturnInterpreter,
} from "./types.js";
import type { RoutedEmail } from "./routing.js";

export interface Interpreters {
  readonly parcels: MailInterpreter;
  readonly orders: MailOrderInterpreter;
  readonly returns: MailReturnInterpreter;
}

/** Why a custom email rule cannot be used; `index` is its place in the list checked. */
export interface RuleProblem {
  readonly index: number;
  readonly id: string | null;
  readonly message: string;
}

function ruleId(definition: unknown): string | null {
  return typeof definition === "object" &&
    definition !== null &&
    "id" in definition &&
    typeof definition.id === "string"
    ? definition.id
    : null;
}

/**
 * Reads email with the shared rules, the email rules of providers (`docs/rules-split.md`) and the
 * owner's custom email rules (the email lab's, stored in the database). The core runs them, never
 * the sandbox, through the interpreters the inbox uses, so an email reads the same everywhere.
 * Custom rules are added to the shared rules and to every provider's rules; they never replace one.
 */
export class EmailRuleReader {
  #custom: readonly EmailRuleDefinition[];
  #compiled = new WeakMap<readonly EmailRuleDefinition[], Rules>();
  #shared: Rules | undefined;
  readonly #interpreters = new WeakMap<Rules, Interpreters>();

  constructor(
    private readonly rules: Rules,
    readonly timeZone: string,
    custom: readonly EmailRuleDefinition[] = [],
  ) {
    this.#custom = custom;
  }

  get custom(): readonly EmailRuleDefinition[] {
    return this.#custom;
  }

  /** Swaps the custom rules (each already checked with `problems`); applies to the next email. */
  setCustom(custom: readonly EmailRuleDefinition[]): void {
    this.#custom = custom;
    this.#compiled = new WeakMap();
    this.#shared = undefined;
  }

  /** The same rules with other custom rules, for trying candidates without saving them. */
  withCustom(custom: readonly EmailRuleDefinition[]): EmailRuleReader {
    return new EmailRuleReader(this.rules, this.timeZone, custom);
  }

  /** Ids of the shared rules: a custom rule may not reuse one. */
  sharedIds(): ReadonlySet<string> {
    return new Set(this.rules.mailRules.map((rule) => rule.id));
  }

  /**
   * The rules an email is read with: a provider's (`definitions`) or, for null, the shared ones;
   * both with the custom rules. Throws when a provider's rule does not match the schema.
   */
  rulesFor(definitions: readonly EmailRuleDefinition[] | null): Rules {
    if (definitions === null) {
      this.#shared ??= this.#withAdded(this.#custom);
      return this.#shared;
    }
    let rules = this.#compiled.get(definitions);
    if (rules === undefined) {
      rules = withEmailRules(this.rules, [...definitions, ...this.#custom]);
      this.#compiled.set(definitions, rules);
    }
    return rules;
  }

  interpreters(rules: Rules): Interpreters {
    let interpreters = this.#interpreters.get(rules);
    if (interpreters === undefined) {
      interpreters = {
        parcels: createMailInterpreter(rules, this.timeZone),
        orders: createOrderInterpreter(rules, this.timeZone),
        returns: createReturnInterpreter(rules, this.timeZone),
      };
      this.#interpreters.set(rules, interpreters);
    }
    return interpreters;
  }

  /** Compiles a provider's rules once; throws when one does not match the email rule schema. */
  prepare(definitions: readonly EmailRuleDefinition[]): Interpreters {
    return this.interpreters(this.rulesFor(definitions));
  }

  /** The shared rules' interpreters, for every email no provider read. */
  shared(): Interpreters {
    return this.interpreters(this.rulesFor(null));
  }

  /**
   * What the provider's rules find in an email, possibly nothing. Either way the email has been
   * read: these rules are everything the shared rules applied to the sender before its rules
   * moved (the `ignore` rules, schema.org markup and the fallback included), so the shared rules
   * must not read it again.
   */
  read(definitions: readonly EmailRuleDefinition[], mail: MailInput): RoutedEmail {
    const interpreters = this.prepare(definitions);
    return {
      snapshots: interpreters.parcels(mail),
      orders: interpreters.orders(mail),
      returns: interpreters.returns(mail),
    };
  }

  /**
   * What is wrong with candidate custom rules: the email rule schema (as `withEmailRules` checks
   * it), regular expressions that do not compile, ids that are taken (`reserved`: shared and
   * provider rules) or given twice. Empty when every rule can be used.
   */
  problems(definitions: readonly unknown[], reserved: ReadonlySet<string>): RuleProblem[] {
    const seen = new Set<string>();
    const problems: RuleProblem[] = [];
    definitions.forEach((definition, index) => {
      const id = ruleId(definition);
      const message =
        id !== null && reserved.has(id)
          ? `The id "${id}" belongs to a shared or provider email rule; choose another.`
          : id !== null && seen.has(id)
            ? `The id "${id}" is given twice.`
            : this.#schemaProblem(definition);
      if (id !== null) seen.add(id);
      if (message !== null) problems.push({ index, id, message });
    });
    return problems;
  }

  #schemaProblem(definition: unknown): string | null {
    try {
      withEmailRules(this.rules, [definition]);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message.replace(/^Email rule 0 /, "The rule ") : "";
    }
  }

  /** The shared rules plus the custom ones (which `withEmailRules` alone would put in their place). */
  #withAdded(custom: readonly EmailRuleDefinition[]): Rules {
    if (custom.length === 0) return this.rules;
    const ids = new Set(custom.map((definition) => definition.id));
    const added = withEmailRules(this.rules, custom).mailRules.filter((rule) => ids.has(rule.id));
    return { ...this.rules, mailRules: [...this.rules.mailRules, ...added] };
  }
}
