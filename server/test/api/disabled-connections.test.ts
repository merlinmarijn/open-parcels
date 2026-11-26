import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { demoCarrier } from "../../src/carriers/demo/index.js";
import { demoShop } from "../../src/carriers/demo_shop/index.js";
import type { Order } from "../../src/domain/order-lifecycle.js";
import { registerBuiltin } from "../manifests.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

let context: TestContext;
let app: App;
let headers: Record<string, string>;
let shopConnection: string;

beforeEach(async () => {
  context = await createTestContext({
    providers: [registerBuiltin(demoCarrier), registerBuiltin(demoShop)],
  });
  app = await context.app();
  const session = await signIn(context, app);
  headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
  const connection = await context.services.connections.create({
    provider: "demo_shop",
    kind: "shop",
    label: "Demo shop",
    config: {},
    secret: null,
  });
  shopConnection = connection.id;
  await context.services.runner.run(connection.id);
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
    url: `/api/v1/connections/${shopConnection}`,
    headers,
    payload: { enabled },
  });
  expect(response.statusCode).toBe(200);
}

describe("disabled connections", () => {
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

  it("links every order to the connection that reported it", async () => {
    const links = await context.services.db
      .selectFrom("order_connections")
      .select(["order_id", "connection_id"])
      .execute();
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => link.connection_id === shopConnection)).toBe(true);
  });
});
