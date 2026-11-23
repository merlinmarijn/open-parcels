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
  return response.json<Order[]>();
}

interface Counts {
  parcels: number;
  orders: number;
  shared: number;
}

describe("clearing a source", () => {
  it("counts first, then removes what only it reported and imports it again", async () => {
    const before = await orders();
    expect(before.length).toBeGreaterThan(0);

    const preview = await app.inject({ url: `/api/v1/sources/${shopSource}/data`, headers });
    expect(preview.statusCode).toBe(200);
    const counts = preview.json<Counts>();
    expect(counts.orders).toBe(before.length);
    expect(counts.parcels).toBeGreaterThan(0);

    // Disabled, so the cleared source does not run again inside the test.
    await app.inject({
      method: "PATCH",
      url: `/api/v1/sources/${shopSource}`,
      headers,
      payload: { enabled: false },
    });
    const cleared = await app.inject({
      method: "POST",
      url: `/api/v1/sources/${shopSource}/clear`,
      headers,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<Counts>()).toEqual(counts);

    const db = context.services.db;
    expect(await db.selectFrom("orders").select("id").execute()).toEqual([]);
    expect(
      await db
        .selectFrom("parcel_sources")
        .where("source_id", "=", shopSource)
        .selectAll()
        .execute(),
    ).toEqual([]);
    const types = (await db.selectFrom("outbox").select("type").execute()).map((row) => row.type);
    expect(types).toContain("order.deleted");
    expect(types).toContain("parcel.deleted");

    // The source and its sign-in stay; a run imports everything again.
    await app.inject({
      method: "PATCH",
      url: `/api/v1/sources/${shopSource}`,
      headers,
      payload: { enabled: true },
    });
    await context.services.runner.run(shopSource);
    expect((await orders()).map((order) => order.order_number).sort()).toEqual(
      before.map((order) => order.order_number).sort(),
    );
  });

  it("needs the admin", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/sources/${shopSource}/clear`,
    });
    expect(response.statusCode).toBe(401);
  });
});
