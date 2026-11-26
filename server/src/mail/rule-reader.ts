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

interface Interpreters {
  readonly parcels: MailInterpreter;
  readonly orders: MailOrderInterpreter;
  readonly returns: MailReturnInterpreter;
}

/**
 * Reads the emails routed to a provider that brings email rules instead of `parseEmail`
 * (`docs/rules-split.md`). The core runs them, never the sandbox: the shared rules with the
 * provider's email rules in place of the shared ones, through the interpreters the inbox uses for
 * the shared rules, so an email reads exactly as it did while its rules were shared.
 */
export class EmailRuleReader {
  readonly #compiled = new WeakMap<readonly EmailRuleDefinition[], Interpreters>();

  constructor(
    private readonly rules: Rules,
    private readonly timeZone: string,
  ) {}

  /** Compiles a provider's rules once; throws when one does not match the email rule schema. */
  prepare(definitions: readonly EmailRuleDefinition[]): Interpreters {
    let interpreters = this.#compiled.get(definitions);
    if (interpreters === undefined) {
      const own = withEmailRules(this.rules, definitions);
      interpreters = {
        parcels: createMailInterpreter(own, this.timeZone),
        orders: createOrderInterpreter(own, this.timeZone),
        returns: createReturnInterpreter(own, this.timeZone),
      };
      this.#compiled.set(definitions, interpreters);
    }
    return interpreters;
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
}
