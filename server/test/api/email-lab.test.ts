import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../../src/api/app.js";
import type { FetchedMessage, MailboxClient } from "../../src/mail/types.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

/*
 * The email lab and custom email rules, through the API, with the shared rules for real and an
 * in-memory mailbox. Every email, domain and number here is made up.
 */

const SHOP = "orders.lab-shop.example";

function email(uid: number, day: string, subject: string, body: string): FetchedMessage {
  const raw = [
    `From: Lab Shop <ship@${SHOP}>`,
    "To: someone@example.invalid",
    `Subject: ${subject}`,
    `Date: ${new Date(`${day}T10:00:00Z`).toUTCString()}`,
    `Message-ID: <${uid}@${SHOP}>`,
    "",
    body,
  ].join("\r\n");
  return { uid, source: Buffer.from(raw), receivedAt: new Date(`${day}T10:00:00Z`) };
}

/** Shipping emails the shared rules cannot read: the number has no known carrier format. */
const MESSAGES = [
  email(11, "2026-11-10", "Newsletter", "Our autumn picks."),
  email(12, "2026-11-12", "Your order has shipped", "Lab tracking: LAB-0000-1111\nOrder 700001"),
  email(13, "2026-11-15", "Your order has shipped", "Lab tracking: LAB-0000-2222\nOrder 700002"),
];

/** A mailbox holding MESSAGES in INBOX; counts connections so the test sees the lab's own. */
class FakeMailbox implements MailboxClient {
  connects = 0;
  closes = 0;
  fail = false;
  connect(): Promise<void> {
    this.connects += 1;
    return this.fail ? Promise.reject(new Error("private server words")) : Promise.resolve();
  }
  listFolders(): Promise<string[]> {
    return Promise.resolve(["INBOX"]);
  }
  open(): Promise<{ uidValidity: string }> {
    return Promise.resolve({ uidValidity: "1" });
  }
  searchSince(since: Date, before?: Date): Promise<number[]> {
    return Promise.resolve(
      MESSAGES.filter(
        (message) =>
          (message.receivedAt ?? since) >= since &&
          (before === undefined || (message.receivedAt ?? before) < before),
      ).map((message) => message.uid),
    );
  }
  async *fetchAfter(afterUid: number): AsyncIterable<FetchedMessage> {
    for (const message of MESSAGES.filter((entry) => entry.uid > afterUid)) {
      yield await Promise.resolve(message);
    }
  }
  async *fetchUids(uids: readonly number[]): AsyncIterable<FetchedMessage> {
    for (const message of MESSAGES.filter((entry) => uids.includes(entry.uid))) {
      yield await Promise.resolve(message);
    }
  }
  onNewMail(): void {
    // Never announces new email.
  }
  onClose(): void {
    // Never closes on its own.
  }
  close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }
}

/** A custom rule for the made-up shop; the carrier `dhl` is one the shared rules know. */
const RULE = {
  id: "parcel-labshop",
  name: "Lab shop shipping emails",
  kind: "parcel",
  senders: { domains: [SHOP] },
  subject: ["has shipped"],
  carrier: "dhl",
  extract: {
    tracking_number: [{ pattern: "Lab tracking:\\s*(?<tracking_number>LAB-\\d{4}-\\d{4})" }],
  },
  default_status: "in_transit",
  require: ["tracking_number"],
  tests: [{ fixture: "labshop-shipped.eml", expect: [] }],
};

let context: TestContext;
let mailbox: FakeMailbox;
let app: App;
let headers: Record<string, string>;
let inbox: string;

beforeEach(async () => {
  mailbox = new FakeMailbox();
  context = await createTestContext({ mailClientFactory: () => mailbox });
  await context.services.mail.start();
  app = await context.app();
  const session = await signIn(context, app);
  headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/connections",
    headers,
    payload: {
      provider: "imap",
      kind: "mail",
      label: "Inbox",
      config: { host: "imap.example.invalid" },
      secret: { username: "someone@example.invalid", password: ["made", "up"].join("-") },
    },
  });
  inbox = created.json<{ id: string }>().id;
  await context.services.mail.settled(inbox);
});
afterEach(async () => {
  await context.services.mail.stop();
  await context.close();
});

const parcels = async () =>
  (await context.services.parcels.repository.list({}, false)).map((p) => p.tracking_number).sort();

describe("email lab", () => {
  it("lists a folder newest first with detection, over a connection of its own", async () => {
    const watcherConnects = mailbox.connects;
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/connections/${inbox}/email-lab/messages?since=2026-11-01&limit=2`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      total: number;
      messages: { uid: number; subject: string; detection: { outcome: string } }[];
    }>();
    expect(body.total).toBe(3);
    expect(body.messages.map((message) => message.uid)).toEqual([13, 12]);
    expect(body.messages[0]?.detection.outcome).toBe("not_detected");
    expect(mailbox.connects).toBe(watcherConnects + 1);
    expect(mailbox.closes).toBe(1);

    const window = await app.inject({
      method: "GET",
      url: `/api/v1/connections/${inbox}/email-lab/messages?since=2026-11-11&before=2026-11-13`,
      headers,
    });
    expect(window.json<{ total: number }>().total).toBe(1);
  });

  it("shows one email with its text and detection", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/connections/${inbox}/email-lab/messages/12`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      uid: 12,
      from: `Lab Shop <ship@${SHOP}>`,
      subject: "Your order has shipped",
      text: expect.stringContaining("LAB-0000-1111") as unknown,
      detection: { outcome: "not_detected", read_by: "shared_rules", parcels: [] },
    });
    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/connections/${inbox}/email-lab/messages/99`,
      headers,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("is admin only and hides the mail server's own words", async () => {
    const url = `/api/v1/connections/${inbox}/email-lab/messages`;
    // Reading is open in tests (no reader password), but emails need the admin.
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(403);
    mailbox.fail = true;
    const warn = vi.spyOn(context.services.logger, "warn");
    const failed = await app.inject({ method: "GET", url, headers });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: "mailbox_failed" });
    expect(failed.body).not.toContain("private server words");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private server words");
  });

  it("tests candidate rules on an inbox email and on pasted source, reporting problems", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/email-lab/test",
      headers,
      payload: {
        connection_id: inbox,
        uid: 12,
        rules: [RULE, { ...RULE, id: "Bad Id" }, { ...RULE, id: "fallback-x", subject: ["("] }],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      problems: { index: number }[];
      baseline: { outcome: string };
      result: { outcome: string; parcels: unknown[]; rule_results: { rule_id: string }[] };
    }>();
    expect(body.problems.map((problem) => problem.index)).toEqual([1, 2]);
    expect(body.baseline.outcome).toBe("not_detected");
    expect(body.result.outcome).toBe("detected");
    expect(body.result.parcels).toEqual([
      expect.objectContaining({ carrier: "dhl", tracking_number: "LAB-0000-1111" }),
    ]);
    expect(body.result.rule_results[0]?.rule_id).toBe("parcel-labshop");

    const pasted = await app.inject({
      method: "POST",
      url: "/api/v1/email-lab/test",
      headers,
      payload: { raw: MESSAGES[2]?.source.toString() ?? "", rules: [RULE] },
    });
    expect(
      pasted.json<{ result: { parcels: { tracking_number: string }[] } }>().result.parcels,
    ).toEqual([expect.objectContaining({ tracking_number: "LAB-0000-2222" })]);
    // Nothing was saved or stored.
    expect(await parcels()).toEqual([]);
  });

  it("saves a custom rule that applies to new and re-read emails, and deletes it", async () => {
    const save = await app.inject({
      method: "PUT",
      url: `/api/v1/email-rules/${RULE.id}`,
      headers,
      payload: RULE,
    });
    expect(save.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/email-rules", headers })).json(),
    ).toEqual([expect.objectContaining({ id: RULE.id })]);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/connections/${inbox}/email-lab/messages/13`,
      headers,
    });
    expect(listed.json()).toMatchObject({ detection: { outcome: "detected" } });

    const reread = await app.inject({
      method: "POST",
      url: `/api/v1/connections/${inbox}/email-lab/reread`,
      headers,
      payload: { since: "2026-11-11" },
    });
    expect(reread.json()).toEqual({
      messages: 2,
      parcels: 2,
      orders: 0,
      returns: 0,
      truncated: false,
    });
    expect(await parcels()).toEqual(["LAB-0000-1111", "LAB-0000-2222"]);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/email-rules/${RULE.id}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);
    const again = await app.inject({
      method: "DELETE",
      url: `/api/v1/email-rules/${RULE.id}`,
      headers,
    });
    expect(again.statusCode).toBe(404);
  });
});

describe("custom email rules", () => {
  const put = (id: string, payload: unknown) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/email-rules/${id}`,
      headers,
      payload: payload as Record<string, unknown>,
    });

  it("refuses rules that do not match the schema, a taken id or an id other than the path's", async () => {
    const withoutTests: Record<string, unknown> = { ...RULE };
    delete withoutTests["tests"];
    for (const [id, payload] of [
      ["parcel-labshop", withoutTests],
      ["parcel-labshop", { ...RULE, kind: "nonsense" }],
      ["parcel-labshop", { ...RULE, subject: ["(unclosed"] }],
      ["parcel-other", RULE],
      ["ignore-accounts", { ...RULE, id: "ignore-accounts" }],
    ] as const) {
      const response = await put(id, payload);
      expect(response.statusCode, `${id} ${JSON.stringify(payload).slice(0, 60)}`).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_email_rule" });
    }
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/email-rules", headers })).json(),
    ).toEqual([]);
  });

  it("needs the admin", async () => {
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/email-rules/parcel-labshop",
          payload: RULE,
        })
      ).statusCode,
    ).toBe(401);
  });
});
