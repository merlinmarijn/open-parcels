import { describe, expect, it, vi } from "vitest";
import { imapClientFactory, imapOptions } from "../../src/mail/imap-client.js";
import { mailConfigSchema, type FetchedMessage } from "../../src/mail/types.js";

const { FakeImapFlow } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");

  /** Stands in for imapflow's ImapFlow: records calls, answers from `messages`. */
  class FakeImapFlow extends EventEmitter {
    static last: FakeImapFlow | undefined;
    readonly calls: unknown[][] = [];
    messages: { uid: number; source?: Buffer; internalDate?: Date | string }[] = [];
    searchResult: number[] | false = [];
    folders = [
      { path: "INBOX", flags: new Set<string>() },
      { path: "Parent", flags: new Set(["\\Noselect"]) },
      { path: "Parent/Orders", flags: new Set<string>() },
    ];

    list() {
      this.calls.push(["list"]);
      return Promise.resolve(this.folders);
    }

    constructor(readonly options: unknown) {
      super();
      FakeImapFlow.last = this;
    }

    connect(): Promise<void> {
      this.calls.push(["connect"]);
      return Promise.resolve();
    }

    mailboxOpen(folder: string, options: unknown): Promise<{ uidValidity: bigint }> {
      this.calls.push(["mailboxOpen", folder, options]);
      return Promise.resolve({ uidValidity: 42n });
    }

    search(query: unknown, options: unknown): Promise<number[] | false> {
      this.calls.push(["search", query, options]);
      return Promise.resolve(this.searchResult);
    }

    async *fetch(range: string, query: unknown, options: unknown): AsyncGenerator {
      this.calls.push(["fetch", range, query, options]);
      await Promise.resolve();
      yield* this.messages;
    }

    logout(): Promise<void> {
      this.calls.push(["logout"]);
      return Promise.resolve();
    }
  }

  return { FakeImapFlow };
});
type FakeImapFlow = InstanceType<typeof FakeImapFlow>;

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));

const secret = { username: "someone@example.invalid", password: ["made", "up"].join("-") };
const config = mailConfigSchema.parse({ host: "imap.example.invalid" });

async function collect(messages: AsyncIterable<FetchedMessage>): Promise<FetchedMessage[]> {
  const out: FetchedMessage[] = [];
  for await (const message of messages) out.push(message);
  return out;
}

function connect(): { client: ReturnType<typeof imapClientFactory>; flow: FakeImapFlow } {
  const client = imapClientFactory(config, secret);
  const flow = FakeImapFlow.last;
  if (flow === undefined) throw new Error("No client was created.");
  return { client, flow };
}

describe("IMAP connection options (OP-012)", () => {
  it("require STARTTLS without TLS from the start, unless cleartext was allowed", () => {
    expect(imapOptions(config, secret)).toMatchObject({ secure: true });
    expect(imapOptions(config, secret)).not.toHaveProperty("doSTARTTLS");

    const starttls = mailConfigSchema.parse({
      host: "imap.example.invalid",
      port: 143,
      secure: false,
    });
    expect(imapOptions(starttls, secret)).toMatchObject({ secure: false, doSTARTTLS: true });

    const cleartext = mailConfigSchema.parse({
      host: "imap.example.invalid",
      port: 143,
      secure: false,
      allowPlaintext: true,
    });
    expect(imapOptions(cleartext, secret)).not.toHaveProperty("doSTARTTLS");
  });
});

describe("the IMAP client (OP-070)", () => {
  it("lists exact selectable folder paths without opening or reading them", async () => {
    const { client, flow } = connect();
    expect(await client.listFolders()).toEqual(["INBOX", "Parent/Orders"]);
    expect(flow.calls).toEqual([["list"]]);
  });
  it("opens folders read-only, never logs, and reads UIDVALIDITY as text", async () => {
    const { client, flow } = connect();
    expect(flow.options).toMatchObject({ logger: false });
    await client.connect();
    expect(await client.open("INBOX")).toEqual({ uidValidity: "42" });
    expect(flow.calls).toContainEqual(["mailboxOpen", "INBOX", { readOnly: true }]);
  });

  it("searches by UID and treats a failed search as no messages", async () => {
    const { client, flow } = connect();
    const since = new Date("2026-11-01T00:00:00Z");
    flow.searchResult = [3, 4];
    expect(await client.searchSince(since)).toEqual([3, 4]);
    expect(flow.calls).toContainEqual(["search", { since }, { uid: true }]);
    flow.searchResult = false;
    expect(await client.searchSince(since)).toEqual([]);
  });

  it("fetches by UID range, skips messages without a body and keeps only real dates", async () => {
    const { client, flow } = connect();
    const date = new Date("2026-11-10T10:00:00Z");
    flow.messages = [
      { uid: 6, source: Buffer.from("a"), internalDate: date },
      { uid: 7 },
      { uid: 8, source: Buffer.from("c"), internalDate: "not a date" },
    ];
    const messages = await collect(client.fetchAfter(5));
    expect(messages.map(({ uid, receivedAt }) => ({ uid, receivedAt }))).toEqual([
      { uid: 6, receivedAt: date },
      { uid: 8, receivedAt: null },
    ]);
    expect(flow.calls[0]).toEqual([
      "fetch",
      "6:*",
      { uid: true, source: true, internalDate: true },
      { uid: true },
    ]);
    await collect(client.fetchUids([9, 11]));
    expect(flow.calls[1]?.[1]).toBe("9,11");
  });

  it("reports new mail, a close and a connection error, and logs out on close", async () => {
    const { client, flow } = connect();
    const newMail = vi.fn();
    const closed = vi.fn();
    client.onNewMail(newMail);
    client.onClose(closed);
    flow.emit("exists");
    expect(newMail).toHaveBeenCalledOnce();
    flow.emit("close");
    expect(closed).toHaveBeenLastCalledWith(undefined);
    const failure = new Error("reset");
    flow.emit("error", failure);
    expect(closed).toHaveBeenLastCalledWith(failure);
    flow.emit("error", "odd");
    expect(closed.mock.lastCall?.[0]).toBeInstanceOf(Error);
    await client.close();
    expect(flow.calls).toContainEqual(["logout"]);
  });
});
