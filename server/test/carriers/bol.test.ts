import { describe, expect, it } from "vitest";
import { bol } from "../../src/carriers/bol/index.js";
import { pageData } from "../../src/carriers/bol/page.js";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
} from "../../src/provider/errors.js";
import { html, onPrefix, World } from "./harness.js";

const OVERVIEW = "GET www.bol.com/nl/nl/account/bestellingen/overzicht/";
const DETAIL = "GET www.bol.com/nl/nl/account/bestellingen/details/";
const PATH = "/nl/nl/account/bestellingen/details/C000EXMPL1/?order_item_id=1000001";
const secret = { cookie: "JSESSIONID=test-session" };

/** Made-up loader data in the reference-table format observed on Bol's pages. */
function page(route: string, data: unknown): string {
  const table: unknown[] = [];
  function add(value: unknown): number {
    if (value === null) return -5;
    const index = table.length;
    table.push(null);
    table[index] = Array.isArray(value)
      ? value.map(add)
      : typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [`_${add(key)}`, add(entry)]),
          )
        : value;
    return index;
  }
  add({ loaderData: { [`routes/account/orders/${route}`]: data } });
  return `<script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(JSON.stringify(table))})</script>`;
}

const overview = (paths = [PATH]) =>
  html(
    page("OrdersOverviewRoute", {
      identifiedCustomer: {
        orders: [
          {
            reference: "C000EXMPL1",
            items: paths.map((url) => ({
              url,
              id: "1000001",
              quantity: 2,
              offerInformation: { productTitle: "Test product" },
            })),
          },
        ],
      },
    }),
  );
const detail = (delivered = false) =>
  html(
    page("OrderDetailsRoute", {
      orderReference: "C000EXMPL1",
      creationDateTime: "2026-11-25T12:00:00",
      shopOrderItems: [
        {
          id: "1000001",
          quantity: 2,
          url: PATH,
          assets: { assets: [{ renditions: [{ url: "https://media.s-bol.com/test/item.jpg" }] }] },
          offerInformation: {
            productTitle: "Test product",
            retailer: { name: "Test shop" },
            listPrice: { priceInclVat: { amount: 12.5 } },
          },
          returnOption: { returnableUntilDate: "2026-12-29" },
          status: {
            lines: [
              {
                shortTranslatedStatus: delivered ? "Bezorgd" : "Verzonden",
                shipment: {
                  lines: [{ shopOrderItemId: "1000001", quantity: 1 }],
                  transport: {
                    trackTraceCode: "3STEST000000001",
                    deliveryCarrierName: "PostNL Briefpost",
                    eventDateTimes: {
                      successfullyDeliveredDateTime: delivered ? "2026-11-27T12:00:00+01:00" : null,
                    },
                  },
                },
              },
            ],
          },
        },
      ],
    }),
  );

describe("Bol personal account", () => {
  it("imports purchases and hands shipments to their carrier, without storing session data in raw", async () => {
    const world = new World(bol, [onPrefix(OVERVIEW, overview()), onPrefix(DETAIL, detail())]);
    const result = await world.fetchAccount({}, secret);
    expect(result.complete).toBe(false);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "bol",
      trackingNumber: "3STEST000000001",
      sender: "Test shop",
      rawStatus: "Verzonden",
      handoff: { carrier: "postnl", trackingNumber: "3STEST000000001" },
      order: {
        shop: "bol.com",
        orderNumber: "C000EXMPL1",
        placedAt: "2026-11-25T11:00:00.000Z",
        returnUntil: "2026-12-29",
      },
      items: [{ title: "Test product", quantity: 1, price: 12.5, currency: "EUR" }],
      orderItems: [{ title: "Test product", quantity: 2 }],
    });
    expect(JSON.stringify(result.snapshots[0]?.raw)).not.toContain(secret.cookie);
    expect(world.calls[0]?.headers.get("cookie")).toBe(secret.cookie);
  });

  it("sets delivery only from the carrier's delivery timestamp", async () => {
    const world = new World(bol, [onPrefix(OVERVIEW, overview()), onPrefix(DETAIL, detail(true))]);
    expect((await world.fetchAccount({}, secret)).snapshots[0]).toMatchObject({
      delivered: true,
      status: "delivered",
      deliveredAt: "2026-11-27T11:00:00.000Z",
    });
  });

  it("deduplicates item detail addresses", async () => {
    const world = new World(bol, [
      onPrefix(OVERVIEW, overview([PATH, PATH])),
      onPrefix(DETAIL, detail()),
    ]);
    await world.fetchAccount({}, secret);
    expect(world.calls).toHaveLength(2);
  });

  it("accepts an empty account without claiming a complete historical scan", async () => {
    const world = new World(bol, [
      onPrefix(OVERVIEW, html(page("OrdersOverviewRoute", { identifiedCustomer: { orders: [] } }))),
    ]);
    expect(await world.fetchAccount({}, secret)).toEqual({ snapshots: [], complete: false });
  });

  it("requires sign-in and recognises an expired session", async () => {
    const world = new World(bol, [
      onPrefix(OVERVIEW, html("", 302, { location: "https://login.bol.com/wsp/login" })),
    ]);
    await expect(world.fetchAccount()).rejects.toBeInstanceOf(SignInRejectedError);
    await expect(world.fetchAccount({}, secret)).rejects.toBeInstanceOf(SignInRejectedError);
    expect(world.calls).toHaveLength(1);
  });

  it.each([new TypeError("offline"), html("blocked", 403), html("unavailable", 503)])(
    "never signs in again on network or server failures",
    async (reply) => {
      const world = new World(bol, [onPrefix(OVERVIEW, reply)]);
      await expect(world.fetchAccount({}, secret)).rejects.toBeInstanceOf(TransientError);
      expect(world.calls).toHaveLength(1);
    },
  );

  it.each([
    "https://evil.example/order",
    "/nl/nl/account/bestellingen/details/C000EXMPL1/../../logout",
    "//evil.example/order",
  ])("rejects unsafe detail addresses", async (path) => {
    const world = new World(bol, [onPrefix(OVERVIEW, overview([path]))]);
    await expect(world.fetchAccount({}, secret)).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(world.calls).toHaveLength(1);
  });

  it.each([
    "<html>changed</html>",
    page("OrdersOverviewRoute", {}),
    '<script>window.__reactRouterContext.streamController.enqueue("[999]")</script>',
  ])("fails closed on changed pages and corrupt references", async (body) => {
    const world = new World(bol, [onPrefix(OVERVIEW, html(body))]);
    await expect(world.fetchAccount({}, secret)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it("never executes scripts embedded in a page", () => {
    expect(() =>
      pageData(
        '<script>window.__reactRouterContext.streamController.enqueue(alert("unsafe"))</script>',
        "OrdersOverviewRoute",
      ),
    ).toThrow(UnexpectedResponseError);
  });
});
