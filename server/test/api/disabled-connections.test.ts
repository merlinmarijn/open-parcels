import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { demoCarrier, demoShop } from "../../src/carriers/demo/index.js";
import type { Order } from "../../src/domain/order-lifecycle.js";
import { register } from "../../src/engine/registry.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

let context: TestContext;
let app: App;
let headers: Record<string, string>;
let shopSource: string;

beforeEach(async () => {
  context = await createTestContext({ plugins: [register(demoCarrier), register(demoShop)] });
  app = await context.app();
  const session = await signIn(context, app);
  headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
  const source = await context.services.sources.create({
    plugin: "demo_shop",
    kind: "shop",
    label: "Demo shop",
    config: {},
    secret: null,
  });
  shopSource = source.id;
  await context.services.runner.run(source.id);
});
afterEach(async () => {
  await context.close();
});

async function orders(): Promise<Order[]> {
  const response = await app.inject({ url: "/api/v1/orders?view=all", headers });
  expect(response.statusCode).toBe(200);
  return response.json<Order[]>();
}

async function parcelIds(): Promise<string[]> {
  const response = await app.inject({ url: "/api/v1/parcels?include_archived=true", headers });
  expect(response.statusCode).toBe(200);
  return response.json<{ id: string }[]>().map((parcel) => parcel.id);
}

async function setEnabled(enabled: boolean): Promise<void> {
  const response = await app.inject({
    method: "PATCH",
    url: `/api/v1/sources/${shopSource}`,
    headers,
    payload: { enabled },
  });
  expect(response.statusCode).toBe(200);
}

describe("disabled sources", () => {
  it("hide their orders and parcels everywhere until enabled again", async () => {
    const before = await orders();
    const order = before.find((entry) => entry.order_number === "DEMO-1001");
    if (order === undefined) throw new Error("no demo order");
    const shopParcels = order.parcels.map((parcel) => parcel.id);
    expect(shopParcels.length).toBeGreaterThan(0);
    expect(await parcelIds()).toEqual(expect.arrayContaining(shopParcels));

    await setEnabled(false);
    expect((await orders()).map((entry) => entry.id)).not.toContain(order.id);
    const visible = await parcelIds();
    for (const id of shopParcels) {
      expect(visible).not.toContain(id);
      const one = await app.inject({ url: `/api/v1/parcels/${id}`, headers });
      expect(one.statusCode).toBe(404);
    }
    const hiddenOrder = await app.inject({ url: `/api/v1/orders/${order.id}`, headers });
    expect(hiddenOrder.statusCode).toBe(404);

    await setEnabled(true);
    expect((await orders()).map((entry) => entry.id)).toContain(order.id);
    expect(await parcelIds()).toEqual(expect.arrayContaining(shopParcels));
  });

  it("links every order to the source that reported it", async () => {
    const links = await context.services.db
      .selectFrom("order_sources")
      .select(["order_id", "source_id"])
      .execute();
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => link.source_id === shopSource)).toBe(true);
  });
});
