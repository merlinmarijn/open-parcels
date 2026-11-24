import { loadRules } from "open-parcels-rules";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import type { Order } from "../../src/domain/order-lifecycle.js";
import { createMailInterpreter, createOrderInterpreter } from "../../src/mail/interpret.js";
import { createReturnInterpreter } from "../../src/mail/returns.js";
import type { MailInput } from "../../src/mail/types.js";
import { toMailInput } from "../../src/mail/watcher.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

/** Made-up emails in the shapes the rules (2.0.0-dev.11) read. */
const rules = loadRules();
const ZONE = "Europe/Berlin";
const interpretOrders = createOrderInterpreter(rules, ZONE);
const interpretParcels = createMailInterpreter(rules, ZONE);
const interpretReturns = createReturnInterpreter(rules, ZONE);

function email(lines: readonly string[]): Promise<MailInput> {
  return toMailInput(Buffer.from(lines.join("\r\n")), null, new Date("2026-11-24T00:00:00Z"));
}

const temu = (subject: string, date: string) =>
  email([
    "From: Temu <temu@orders.temu.com>",
    "To: someone@example.invalid",
    `Subject: ${subject}`,
    `Date: ${date}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Order PO-076-01234567890123456</p>",
  ]);

const steamReceipt = () =>
  email([
    'From: "Steam Support" <noreply@steampowered.com>',
    "To: someone@example.invalid",
    "Subject: Thank you for your Steam purchase!",
    "Date: Sat, 14 Nov 2026 16:07:00 +0000",
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Thank you for your recent transaction on Steam.",
    "",
    "--b1",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><p>Example Space Game</p><p>Subtotal (excl. VAT): 11,76€</p>",
    "<p>Invoice:</p><p>712345678901234567</p></body></html>",
    "--b1--",
  ]);

const paypalReceipt = (reference: string) =>
  email([
    'From: "service@paypal.de" <service@paypal.de>',
    "To: someone@example.invalid",
    "Subject: Receipt for Your Payment to Example Merchant",
    "Date: Sat, 14 Nov 2026 16:07:30 +0100",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "You have sent a payment of 13,99 EUR to Example Merchant.",
    "",
    `Invoice ID: ${reference}`,
  ]);

const shopify = (name: string) =>
  email([
    `From: ${name} <store+12345678@shopifyemail.com>`,
    "To: someone@example.invalid",
    "Subject: Order #1042 confirmed",
    "Date: Mon, 16 Nov 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Order #1042",
  ]);

const ebayUpdate = () =>
  email([
    "From: eBay <ebay@ebay.com>",
    "To: someone@example.invalid",
    "Subject: Update zur Bestellung: Retro-Kofferradio",
    "Date: Wed, 18 Nov 2026 11:00:00 +0100",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Sendungsnummer:</p>",
    '<p><a href="https://www.ebay.de/signin/g/example">00340434123456789012</a></p>',
    "<p>Retro-Kofferradio, gebraucht</p>",
    "<p>Bestellnummer:</p><p>12-34567-89012</p>",
    "<p>Versanddienstleister:</p><p>DHL Germany</p>",
  ]);

describe("order emails (interpreter)", () => {
  it("reads an order_delivered email as an order report, not a parcel or return", async () => {
    const mail = await temu(
      "Your order PO-076-01234567890123456 was delivered",
      "Fri, 20 Nov 2026 10:00:00 +0000",
    );
    expect(interpretOrders(mail)).toEqual([
      {
        order: { shop: "temu", orderNumber: "PO-076-01234567890123456" },
        status: "delivered",
        at: "2026-11-20T10:00:00.000Z",
        items: [],
        payment: false,
      },
    ]);
    expect(interpretParcels(mail)).toEqual([]);
    expect(interpretReturns(mail)).toEqual([]);
  });

  it("reads a digital store's receipt with its items", async () => {
    expect(interpretOrders(await steamReceipt())).toMatchObject([
      {
        order: { shop: "steam", orderNumber: "712345678901234567" },
        status: "ordered",
        items: ["Example Space Game"],
        payment: false,
      },
    ]);
  });

  it("marks a PayPal receipt that quotes a shop's reference as a payment", async () => {
    expect(interpretOrders(await paypalReceipt("712345678901234567"))).toMatchObject([
      { order: { shop: "paypal", orderNumber: "712345678901234567" }, payment: true },
    ]);
  });

  it("names a shop hosted on a platform after the sender, so two shops' #1042 differ", async () => {
    const [first] = interpretOrders(await shopify("Example Coffee Roasters"));
    const [second] = interpretOrders(await shopify("Another Example Shop"));
    expect(first?.order).toEqual({ shop: "example-coffee-roasters", orderNumber: "1042" });
    expect(second?.order).toEqual({ shop: "another-example-shop", orderNumber: "1042" });
  });

  it("links the tracking numbers of an order update to its order", async () => {
    const mail = await ebayUpdate();
    expect(interpretOrders(mail)).toMatchObject([
      { order: { shop: "ebay", orderNumber: "12-34567-89012" }, status: "shipped" },
    ]);
    const parcels = interpretParcels(mail);
    expect(parcels.length).toBeGreaterThan(0);
    for (const parcel of parcels) {
      expect(parcel.order).toMatchObject({ shop: "ebay", orderNumber: "12-34567-89012" });
    }
  });
});

let context: TestContext;
let app: App;
let headers: Record<string, string>;
let inbox: string;

beforeEach(async () => {
  context = await createTestContext();
  app = await context.app();
  const session = await signIn(context, app);
  headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
  const connection = await context.services.connections.create({
    provider: "imap",
    kind: "mail",
    label: "Inbox",
    config: { host: "imap.example.invalid" },
    secret: { username: "someone@example.invalid", password: ["made", "up"].join("-") },
  });
  inbox = connection.id;
});
afterEach(async () => {
  await context.close();
});

/** Feeds emails to the reconciler the way the inbox watcher does. */
async function receive(...mails: MailInput[]): Promise<void> {
  for (const mail of mails) {
    await context.services.reconciler.ingest(inbox, {
      snapshots: interpretParcels(mail),
      returns: interpretReturns(mail),
      orders: interpretOrders(mail),
      complete: false,
    });
  }
}

async function orders(view = "all"): Promise<Order[]> {
  const response = await app.inject({ url: `/api/v1/orders?view=${view}`, headers });
  expect(response.statusCode).toBe(200);
  return response.json<Order[]>();
}

async function orderEvents(): Promise<{ type: string; payload: Order }[]> {
  const rows = await context.services.db
    .selectFrom("outbox")
    .select(["type", "payload"])
    .orderBy("seq")
    .execute();
  return rows
    .filter((row) => row.type.startsWith("order."))
    .map((row) => ({ type: row.type, payload: JSON.parse(row.payload) as Order }));
}

describe("order emails (stored orders)", () => {
  it("starts an order from its confirmation and follows it to delivered, once", async () => {
    await receive(
      await temu(
        "Your order PO-076-01234567890123456 is confirmed",
        "Mon, 16 Nov 2026 09:00:00 +0000",
      ),
    );
    const [created] = await orders("open");
    expect(created).toMatchObject({
      shop: "temu",
      order_number: "PO-076-01234567890123456",
      status: "ordered",
      digital: false,
      placed_at: "2026-11-16T09:00:00.000Z",
      parcel_count: 0,
    });
    await receive(
      await temu(
        "Your order PO-076-01234567890123456 was delivered",
        "Fri, 20 Nov 2026 10:00:00 +0000",
      ),
      // An older email read later moves nothing back.
      await temu(
        "Your order PO-076-01234567890123456 is confirmed",
        "Mon, 16 Nov 2026 09:00:00 +0000",
      ),
    );
    const all = await orders();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "delivered", placed_at: "2026-11-16T09:00:00.000Z" });
    expect(await orders("delivered")).toHaveLength(1);
    const events = await orderEvents();
    expect(events.map((event) => event.type)).toEqual(["order.created", "order.updated"]);
    // The same payload shape as `order.updated` from the API: the order without its parcels.
    expect(events[0]?.payload).toMatchObject({
      id: created?.id,
      shop: "temu",
      status: "ordered",
      parcels: [],
    });
    expect(events[1]?.payload.status).toBe("delivered");
  });

  it("closes a cancelled order: archived, out of the open list", async () => {
    await receive(
      await temu(
        "Your order PO-076-01234567890123456 is confirmed",
        "Mon, 16 Nov 2026 09:00:00 +0000",
      ),
      await temu(
        "Your order PO-076-01234567890123456 was cancelled",
        "Tue, 17 Nov 2026 09:00:00 +0000",
      ),
    );
    expect(await orders("open")).toEqual([]);
    expect(await orders("archived")).toMatchObject([{ status: "cancelled", archived: true }]);
  });

  it("shows a digital order delivered, with its items and no parcel to wait for", async () => {
    await receive(await steamReceipt());
    expect(await orders("open")).toEqual([]);
    expect(await orders("delivered")).toMatchObject([
      {
        shop: "steam",
        status: "delivered",
        digital: true,
        parcel_count: 0,
        items: [{ title: "Example Space Game" }],
      },
    ]);
  });

  it("merges a PayPal receipt into the shop's order, whichever email comes first", async () => {
    await receive(await paypalReceipt("712345678901234567"), await steamReceipt());
    await receive(await paypalReceipt("712345678901234567"));
    const all = await orders();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ shop: "steam", order_number: "712345678901234567" });
    expect(all[0]?.status).toBe("delivered");
  });

  it("keeps a PayPal receipt nobody else claims as its own order", async () => {
    await receive(await paypalReceipt("INV-2026-0042"));
    expect(await orders()).toMatchObject([
      { shop: "paypal", order_number: "INV-2026-0042", status: "ordered" },
    ]);
  });

  it("files the parcel of an order update under the order", async () => {
    await receive(await ebayUpdate());
    const all = await orders();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ shop: "ebay", order_number: "12-34567-89012" });
    expect(all[0]?.parcels.map((parcel) => parcel.tracking_number)).toContain(
      "00340434123456789012",
    );
  });
});
