import type { Kysely } from "kysely";
import { ignoredEmail, type EmailRuleDefinition } from "open-parcels-rules";
import type { Logger } from "pino";
import { DAY_MS, type Clock } from "../clock.js";
import type { SecretBox } from "../crypto/secrets.js";
import type { Database } from "../db/schema.js";
import { secretAad } from "../engine/connections.js";
import type { Reconciler } from "../engine/reconciler.js";
import type { OrderSnapshot, ParcelSnapshot, ReturnSnapshot } from "../provider/snapshot.js";
import type { CustomEmailRules } from "./custom-rules.js";
import { emailResults } from "./interpret.js";
import { mailLines } from "./return-details.js";
import type { EmailRuleReader, RuleProblem } from "./rule-reader.js";
import type { EmailRouter, RoutedEmail } from "./routing.js";
import {
  MAIL_PROVIDER,
  mailConfigSchema,
  mailSecretSchema,
  type FetchedMessage,
  type MailboxClient,
  type MailboxClientFactory,
  type MailConfig,
  type MailInput,
} from "./types.js";
import { toMailInput } from "./watcher.js";

/** Messages a list page and a re-read handle at most. */
export const EMAIL_LAB_PAGE_MAX = 50;
const REREAD_MAX = 1000;
const DEFAULT_DAYS = 30;

/** What one rule made of an email, before the interpreters turned it into parcels and orders. */
interface RuleResult {
  rule_id: string;
  kind: string;
  carrier: string | null;
  tracking_numbers: string[];
  order_numbers: string[];
  status: string | null;
  event: string | null;
}

/** How an email is read, as the email lab shows it. Never logged: it is personal data. */
export interface Detection {
  outcome: "detected" | "ignored" | "not_detected";
  read_by: "providers" | "shared_rules";
  /** Providers whose manifest names the sender's domain and that the sender check let through. */
  providers: string[];
  rule_results: RuleResult[];
  parcels: {
    carrier: string;
    tracking_number: string;
    status: string | null;
    shop: string | null;
    order_number: string | null;
  }[];
  orders: { shop: string; order_number: string; status: string | null }[];
  returns: {
    shop: string;
    order_number: string;
    status: string | null;
    tracking_number: string | null;
  }[];
}

export interface EmailLabMessage {
  uid: number;
  date: string | null;
  from: string;
  subject: string;
  detection: Detection;
}

export interface EmailLabMessageDetail extends EmailLabMessage {
  message_id: string | null;
  authentication_results: string | null;
  text: string | null;
  html_text: string | null;
}

export class EmailLabNotFoundError extends Error {
  override readonly name = "EmailLabNotFoundError";

  constructor(readonly resource: "connection" | "message") {
    super(`The ${resource} was not found.`);
  }
}

/** The mail server refused or failed; its own words can hold personal data and are dropped. */
export class EmailLabMailboxError extends Error {
  override readonly name = "EmailLabMailboxError";
}

export interface EmailLabDeps {
  readonly db: Kysely<Database>;
  readonly secrets: SecretBox;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly clientFactory: MailboxClientFactory;
  readonly router: EmailRouter;
  readonly reader: EmailRuleReader;
  readonly customRules: CustomEmailRules;
  readonly reconciler: Reconciler;
  readonly followUp: (connectionId: string) => Promise<void>;
}

export interface Window {
  readonly since?: string | undefined;
  readonly before?: string | undefined;
}

interface Inbox {
  readonly id: string;
  readonly config: MailConfig;
  open(): MailboxClient;
}

const day = (value: string): Date => new Date(`${value}T00:00:00Z`);

/**
 * The email lab: reads an inbox's emails over a short-lived connection of its own (so the IDLE
 * watcher is never disturbed), shows how each is read, tries candidate email rules on them and
 * reads a window again after a rule was saved. Folders are opened read-only.
 */
export class EmailLab {
  constructor(private readonly deps: EmailLabDeps) {}

  /** Messages of a folder in a window, newest first, with how each is read. */
  async list(
    connectionId: string,
    folder: string,
    window: Window,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<{ total: number; messages: EmailLabMessage[] }> {
    const inbox = await this.#inbox(connectionId);
    return this.#session(inbox, async (client) => {
      await client.open(folder);
      const uids = (await this.#search(client, window)).sort((a, b) => b - a);
      const wanted = uids.slice(page.offset, page.offset + page.limit);
      const messages: EmailLabMessage[] = [];
      for await (const message of client.fetchUids(wanted)) {
        const mail = await this.#mail(message);
        const { detection } = await this.#detect(inbox, mail, this.deps.reader);
        messages.push({ uid: message.uid, ...summary(mail), detection });
      }
      return { total: uids.length, messages: messages.sort((a, b) => b.uid - a.uid) };
    });
  }

  /** One message: its headers, its text, its HTML as text and how it is read. */
  async get(connectionId: string, folder: string, uid: number): Promise<EmailLabMessageDetail> {
    const inbox = await this.#inbox(connectionId);
    const { message, mail } = await this.#fetch(inbox, folder, uid);
    const { detection } = await this.#detect(inbox, mail, this.deps.reader);
    return { uid: message.uid, ...detail(mail), detection };
  }

  /**
   * Reads one email (from an inbox, or pasted as RFC 822 source) with candidate custom rules in
   * place of saved ones of the same id. Candidates with problems are left out of `result`.
   */
  async test(input: {
    readonly connectionId?: string | undefined;
    readonly folder: string;
    readonly uid?: number | undefined;
    readonly raw?: string | undefined;
    readonly rules: readonly unknown[];
    readonly checkSenders?: boolean | undefined;
  }): Promise<{
    problems: RuleProblem[];
    message: EmailLabMessageDetail;
    baseline: Detection;
    result: Detection;
  }> {
    const inbox = input.connectionId === undefined ? null : await this.#inbox(input.connectionId);
    let uid = 0;
    let mail: MailInput;
    if (input.raw !== undefined) {
      mail = await toMailInput(Buffer.from(input.raw), null, this.deps.clock.now());
    } else if (inbox !== null && input.uid !== undefined) {
      ({ mail } = await this.#fetch(inbox, input.folder, input.uid));
      uid = input.uid;
    } else {
      throw new EmailLabNotFoundError("message");
    }
    const checking = {
      id: inbox?.id ?? "email-lab",
      config: { ...(inbox?.config ?? mailConfigSchema.parse({ host: "email-lab.invalid" })) },
      open: () => {
        throw new EmailLabMailboxError("No inbox.");
      },
    };
    if (input.checkSenders !== undefined) {
      checking.config.checkSenders = input.checkSenders;
    }
    const problems = this.deps.customRules.check(input.rules);
    const bad = new Set(problems.map((problem) => problem.index));
    const candidates = input.rules.filter((_, index) => !bad.has(index)) as EmailRuleDefinition[];
    const ids = new Set(candidates.map((rule) => rule.id));
    const reader = this.deps.reader.withCustom([
      ...this.deps.reader.custom.filter((rule) => !ids.has(rule.id)),
      ...candidates,
    ]);
    const baseline = (await this.#detect(checking, mail, this.deps.reader)).detection;
    const result = (await this.#detect(checking, mail, reader)).detection;
    return { problems, message: { uid, ...detail(mail), detection: baseline }, baseline, result };
  }

  /**
   * Reads a window of an inbox again with the rules in use and stores what it finds, as the
   * watcher would have. Additive: nothing stored is removed, and an email read twice adds no
   * second history entry. At most the newest 1000 messages per call.
   */
  async reread(
    connectionId: string,
    window: Window,
    folders: readonly string[] | undefined,
  ): Promise<{
    messages: number;
    parcels: number;
    orders: number;
    returns: number;
    truncated: boolean;
  }> {
    const inbox = await this.#inbox(connectionId);
    const found = {
      snapshots: [] as ParcelSnapshot[],
      orders: [] as OrderSnapshot[],
      returns: [] as ReturnSnapshot[],
    };
    let messages = 0;
    let truncated = false;
    await this.#session(inbox, async (client) => {
      for (const folder of folders ?? inbox.config.folders) {
        await client.open(folder);
        const uids = (await this.#search(client, window)).sort((a, b) => b - a);
        const wanted = uids.slice(0, REREAD_MAX - messages);
        truncated ||= wanted.length < uids.length;
        for await (const message of client.fetchUids(wanted)) {
          messages += 1;
          const { read } = await this.#detect(inbox, await this.#mail(message), this.deps.reader);
          found.snapshots.push(...read.snapshots);
          found.orders.push(...read.orders);
          found.returns.push(...read.returns);
        }
      }
    });
    if (found.snapshots.length + found.orders.length + found.returns.length > 0) {
      await this.deps.reconciler.ingest(connectionId, { ...found, complete: false });
      await this.deps.followUp(connectionId);
    }
    return {
      messages,
      parcels: found.snapshots.length,
      orders: found.orders.length,
      returns: found.returns.length,
      truncated,
    };
  }

  async #inbox(connectionId: string): Promise<Inbox> {
    const row = await this.deps.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", connectionId)
      .executeTakeFirst();
    if (row?.kind !== "mail" || row.provider !== MAIL_PROVIDER || row.secret_blob === null) {
      throw new EmailLabNotFoundError("connection");
    }
    const config = mailConfigSchema.parse(JSON.parse(row.config));
    const secret = mailSecretSchema.parse(
      this.deps.secrets.decryptJson(row.secret_blob, secretAad(row.id)),
    );
    return { id: row.id, config, open: () => this.deps.clientFactory(config, secret) };
  }

  /** A connection of the lab's own for `work`, closed afterwards whatever happens. */
  async #session<T>(inbox: Inbox, work: (client: MailboxClient) => Promise<T>): Promise<T> {
    const client = inbox.open();
    client.onClose(() => undefined);
    try {
      await client.connect();
      return await work(client);
    } catch (error) {
      if (error instanceof EmailLabNotFoundError) throw error;
      this.deps.logger.warn(
        { connection: inbox.id, error: error instanceof Error ? error.name : "unknown" },
        "The email lab could not read the inbox.",
      );
      throw new EmailLabMailboxError("The mail server refused or failed.");
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async #fetch(
    inbox: Inbox,
    folder: string,
    uid: number,
  ): Promise<{ message: FetchedMessage; mail: MailInput }> {
    return this.#session(inbox, async (client) => {
      await client.open(folder);
      for await (const message of client.fetchUids([uid])) {
        if (message.uid === uid) return { message, mail: await this.#mail(message) };
      }
      throw new EmailLabNotFoundError("message");
    });
  }

  #search(client: MailboxClient, window: Window): Promise<number[]> {
    const since =
      window.since === undefined
        ? new Date(this.deps.clock.now().getTime() - DEFAULT_DAYS * DAY_MS)
        : day(window.since);
    return client.searchSince(since, window.before === undefined ? undefined : day(window.before));
  }

  #mail(message: FetchedMessage): Promise<MailInput> {
    return toMailInput(message.source, message.receivedAt ?? null, this.deps.clock.now());
  }

  /** Reads an email as the watcher does (providers first, else the shared rules) and explains it. */
  async #detect(
    inbox: Inbox,
    mail: MailInput,
    reader: EmailRuleReader,
  ): Promise<{ read: RoutedEmail; detection: Detection }> {
    const { checkSenders } = inbox.config;
    const routes = this.deps.router.routes(mail, checkSenders);
    const routed = await this.deps.router.read(inbox.id, mail, checkSenders, reader);
    const ruled = routes.flatMap((provider) =>
      provider.emailRules === null ? [] : [provider.emailRules],
    );
    const rules =
      routed !== null ? ruled.map((own) => reader.rulesFor(own)) : [reader.rulesFor(null)];
    const read: RoutedEmail =
      routed ??
      safely<RoutedEmail>(
        () => {
          const shared = reader.shared();
          return {
            snapshots: shared.parcels(mail),
            orders: shared.orders(mail),
            returns: shared.returns(mail),
          };
        },
        { snapshots: [], orders: [], returns: [] },
      );
    const results = rules.flatMap((set) =>
      safely(() => emailResults(set, mail, reader.timeZone), []),
    );
    const found = read.snapshots.length + read.orders.length + read.returns.length > 0;
    const ignored = rules.some((set) => ignoredEmail(set, mail.from, mail.subject));
    return {
      read,
      detection: {
        outcome: found ? "detected" : ignored ? "ignored" : "not_detected",
        read_by: routed === null ? "shared_rules" : "providers",
        providers: routes.map((provider) => provider.info.id),
        rule_results: results.map((result) => ({
          rule_id: result.ruleId,
          kind: result.kind,
          carrier: result.carrier ?? null,
          tracking_numbers: [...result.trackingNumbers],
          order_numbers: [...result.orderNumbers],
          status: result.status ?? null,
          event: result.event ?? null,
        })),
        parcels: read.snapshots.map((parcel) => ({
          carrier: parcel.carrier,
          tracking_number: parcel.trackingNumber,
          status: parcel.status,
          shop: parcel.order?.shop ?? null,
          order_number: parcel.order?.orderNumber ?? null,
        })),
        orders: read.orders.map((order) => ({
          shop: order.order.shop,
          order_number: order.order.orderNumber,
          status: order.status,
        })),
        returns: read.returns.map((entry) => ({
          shop: entry.order.shop,
          order_number: entry.order.orderNumber,
          status: entry.status,
          tracking_number: entry.tracking?.trackingNumber ?? null,
        })),
      },
    };
  }
}

/** One odd email must not fail a whole page; what it gave is then nothing. */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function summary(mail: MailInput): Omit<EmailLabMessage, "uid" | "detection"> {
  return { date: mail.date?.toISOString() ?? null, from: mail.from, subject: mail.subject };
}

function detail(mail: MailInput): Omit<EmailLabMessageDetail, "uid" | "detection"> {
  return {
    ...summary(mail),
    message_id: mail.messageId,
    authentication_results: mail.authentication,
    text: mail.text,
    html_text: mail.html === null ? null : mailLines(null, mail.html).join("\n"),
  };
}
