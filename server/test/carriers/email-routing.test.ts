import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { demoShop } from "../../src/carriers/demo_shop/index.js";
import type { FetchedMessage, MailboxClient, MailInput } from "../../src/mail/types.js";
import { snapshot } from "../../src/provider/api.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";
import { registerBuiltin } from "../manifests.js";

/*
 * Email routing end to end, through the demo shop's `parseEmail`. In the `providers-pool` project
 * the demo shop runs in a sandbox child, so routing is covered in both isolation modes. Every
 * email here is made up.
 */

const SHOP_DOMAIN = "shop.open-parcels.example";
const PASSED = `mx.example.invalid; dkim=pass (2048-bit key) header.i=@${SHOP_DOMAIN} header.s=s1; spf=pass smtp.mailfrom=${SHOP_DOMAIN}; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${SHOP_DOMAIN}`;
const FAILED = `mx.example.invalid; dkim=fail header.d=${SHOP_DOMAIN}; dmarc=fail header.from=${SHOP_DOMAIN}`;

/** A mailbox holding the given raw messages in INBOX. */
class FakeMailbox implements MailboxClient {
  constructor(readonly messages: readonly FetchedMessage[]) {}
  connect(): Promise<void> {
    return Promise.resolve();
  }
  open(): Promise<{ uidValidity: string }> {
    return Promise.resolve({ uidValidity: "1" });
  }
  searchSince(): Promise<number[]> {
    return Promise.resolve(this.messages.map((message) => message.uid));
  }
  async *fetchAfter(afterUid: number): AsyncIterable<FetchedMessage> {
    for (const message of this.messages.filter((entry) => entry.uid > afterUid)) {
      yield await Promise.resolve(message);
    }
  }
  async *fetchUids(uids: readonly number[]): AsyncIterable<FetchedMessage> {
    for (const message of this.messages.filter((entry) => uids.includes(entry.uid))) {
      yield await Promise.resolve(message);
    }
  }
  onNewMail(): void {
    // Never announces new email: each test reads the first sync only.
  }
  onClose(): void {
    // Never closes on its own.
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A shipping email naming DEMO0000000001; `authentication` lines are listed topmost first. */
function shippingEmail(uid: number, authentication: readonly string[]): FetchedMessage {
  const raw = [
    ...authentication.map((line) => `Authentication-Results: ${line}`),
    `From: Demo shop <shipping@${SHOP_DOMAIN}>`,
    "To: someone@example.invalid",
    "Subject: Your order DEMO-1001 has shipped",
    "Date: Tue, 17 Nov 2026 10:00:00 +0000",
    `Message-ID: <${uid}@${SHOP_DOMAIN}>`,
    "",
    "Your parcel DEMO0000000001 is on its way.",
  ].join("\r\n");
  return { uid, source: Buffer.from(raw), receivedAt: new Date("2026-11-17T10:00:00Z") };
}

let context: TestContext | undefined;
let ruled: MailInput[];

afterEach(async () => {
  await context?.services.mail.stop();
  await context?.close();
  context = undefined;
});

/**
 * The shared email rules as a stand-in that reads every email naming DEMO0000000001 as a parcel
 * of the demo courier: if the router let the rules read a routed email too, it would make a
 * second parcel.
 */
function rules(mail: MailInput) {
  ruled.push(mail);
  return mail.text?.includes("DEMO0000000001") === true
    ? [
        snapshot({
          carrier: "demo",
          trackingNumber: "DEMO0000000001",
          status: null,
          rawStatus: null,
        }),
      ]
    : [];
}

/** Starts a server with the demo shop, adds an inbox holding `messages` and waits for its sync. */
async function readInbox(
  messages: readonly FetchedMessage[],
  env: Readonly<Record<string, string>> = {},
  inbox: Readonly<Record<string, unknown>> = {},
) {
  ruled = [];
  const mailbox = new FakeMailbox(messages);
  context = await createTestContext({
    providers: [registerBuiltin(demoShop)],
    mailClientFactory: () => mailbox,
    mailInterpreter: rules,
    env,
  });
  await context.services.mail.start();
  const app: App = await context.app();
  const session = await signIn(context, app);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/connections",
    headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
    payload: {
      provider: "imap",
      kind: "mail",
      label: "Inbox",
      config: { host: "imap.example.invalid", ...inbox },
      secret: { username: "someone@example.invalid", password: ["made", "up"].join("-") },
    },
  });
  expect(response.statusCode).toBe(201);
  await context.services.mail.settled(response.json<{ id: string }>().id);
  return context.services.parcels.repository.list({}, false);
}

describe("email routing", () => {
  it("hands an authenticated email to the provider of its sender domain, never to the rules too", async () => {
    const parcels = await readInbox([shippingEmail(1, [PASSED]), shippingEmail(2, [PASSED])]);

    expect(ruled).toEqual([]);
    expect(parcels).toHaveLength(1);
    expect(parcels[0]).toMatchObject({
      tracking_number: "DEMO0000000001",
      order: { order_number: "DEMO-1001" },
    });
  });

  it("gives an email whose sender is not confirmed to the rules only", async () => {
    // A forged header below the receiving server's own counts for nothing.
    const parcels = await readInbox([shippingEmail(1, [FAILED, PASSED]), shippingEmail(2, [])]);

    expect(ruled.map((mail) => mail.messageId)).toEqual([
      `<1@${SHOP_DOMAIN}>`,
      `<2@${SHOP_DOMAIN}>`,
    ]);
    expect(parcels.map((parcel) => parcel.carrier)).toEqual(["demo"]);
  });

  it("routes by the sender's domain alone in an inbox that does not check senders", async () => {
    const parcels = await readInbox([shippingEmail(1, [])], {}, { checkSenders: false });

    expect(ruled).toEqual([]);
    expect(parcels).toHaveLength(1);
    expect(parcels[0]).toMatchObject({ order: { order_number: "DEMO-1001" } });
  });

  it("leaves every email to the rules while the switch is off", async () => {
    const parcels = await readInbox([shippingEmail(1, [PASSED])], {
      OPENPARCELS_EMAIL_ROUTING: "false",
    });

    expect(ruled).toHaveLength(1);
    expect(parcels.map((parcel) => parcel.carrier)).toEqual(["demo"]);
  });
});
