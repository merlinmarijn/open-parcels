import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SnapshotItem } from "../../src/provider/api.js";
import { FakeWorld, fakePost, fakeShop, snapshot } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* A shop renaming a shipment as it moves. Every code and title is made up. */

let context: TestContext;
let shop: FakeWorld;

beforeEach(async () => {
  shop = new FakeWorld();
  context = await createTestContext({ providers: [fakePost(new FakeWorld()), fakeShop(shop)] });
});
afterEach(async () => {
  await context.close();
});

const order = { shop: "fakeshop", orderNumber: "000-0000000-0000009", placedAt: null };
const item = (title: string): SnapshotItem => ({
  title,
  imageUrl: null,
  url: null,
  externalId: null,
  quantity: null,
  price: null,
  currency: null,
});
const line = (trackingNumber: string, title: string, handoff: string | null = null) =>
  snapshot({
    carrier: "fakeshop",
    trackingNumber,
    status: "registered",
    rawStatus: null,
    order,
    items: [item(title)],
    handoff: handoff === null ? null : { carrier: "fakepost", trackingNumber: handoff },
  });

describe("a shop that renames its shipments", () => {
  it("keeps one parcel per shipment from order line to shipment id to carrier code", async () => {
    const id = (
      await context.services.connections.create({
        provider: "fakeshop",
        kind: "shop",
        label: "shop",
        config: {},
        secret: null,
      })
    ).id;
    const rows = () =>
      context.services.db
        .selectFrom("parcels")
        .select(["carrier", "tracking_number"])
        .orderBy("tracking_number")
        .execute();

    shop.listing = [line("ORDER-1", "Grater"), line("ORDER-2", "Kettle")];
    await context.services.runner.run(id);
    shop.listing = [line("SHIPA0001", "Grater"), line("ORDER-2", "Kettle")];
    await context.services.runner.run(id);
    shop.listing = [line("SHIPA0001", "Grater", "FP00000001"), line("SHIPB0001", "Kettle")];
    await context.services.runner.run(id);

    expect(await rows()).toEqual([
      { carrier: "fakepost", tracking_number: "FP00000001" },
      { carrier: "fakeshop", tracking_number: "SHIPB0001" },
    ]);
  });
});
