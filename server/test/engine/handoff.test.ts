import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeWorld, fakePost, fakeShop, snapshot } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* Inferred hand-offs between shops and carriers. Every code is made up. */

let context: TestContext;
let post: FakeWorld;
let shop: FakeWorld;

beforeEach(async () => {
  post = new FakeWorld();
  shop = new FakeWorld();
  context = await createTestContext({ providers: [fakePost(post), fakeShop(shop)] });
});
afterEach(async () => {
  await context.close();
});

const CODE = "SHARED00000001";

async function shopConnection(): Promise<string> {
  return (
    await context.services.connections.create({
      provider: "fakeshop",
      kind: "shop",
      label: "shop",
      config: {},
      secret: { refreshToken: ["r", "t"].join("-") },
    })
  ).id;
}

describe("an inferred hand-off", () => {
  it("never targets a parcel stored under another shop", async () => {
    const now = context.clock.now().toISOString();
    // A second shop, known only by its connection row and the parcel it stored.
    await context.services.db
      .insertInto("connections")
      .values({
        id: crypto.randomUUID(),
        provider: "othershop",
        kind: "shop",
        label: "Other shop",
        config: "{}",
        secret_blob: null,
        session_blob: null,
        state: "ok",
        state_reason: null,
        carrier_message: null,
        next_run_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await context.services.db
      .insertInto("parcels")
      .values({
        id: crypto.randomUUID(),
        carrier: "othershop",
        tracking_number: CODE,
        direction: "receiving",
        status: "registered",
        raw_status: null,
        delivered: 0,
        pickup: 0,
        label: "Other order",
        first_seen_at: now,
        last_seen_at: now,
        updated_at: now,
      })
      .execute();
    shop.listing = [
      snapshot({ carrier: "fakeshop", trackingNumber: CODE, status: null, rawStatus: null }),
    ];
    await context.services.runner.run(await shopConnection());
    const rows = await context.services.db
      .selectFrom("parcels")
      .select("carrier")
      .orderBy("carrier")
      .execute();
    expect(rows.map((row) => row.carrier)).toEqual(["fakeshop", "othershop"]);
  });

  it("folds the shop's parcel into the carrier's, keeping its manual status and raw data", async () => {
    shop.listing = [
      snapshot({
        carrier: "fakeshop",
        trackingNumber: CODE,
        status: null,
        rawStatus: null,
        raw: { order: "made-up" },
      }),
    ];
    const fromShop = await shopConnection();
    await context.services.runner.run(fromShop);
    const shopParcel = await context.services.db
      .selectFrom("parcels")
      .select("id")
      .executeTakeFirstOrThrow();
    await context.services.db
      .updateTable("parcels")
      .set({ manual_status: "in_transit", manual_at: "2026-11-18T11:00:00.000Z" })
      .where("id", "=", shopParcel.id)
      .execute();
    // The carrier's own parcel, stored separately (by hand, say), so the two are folded together.
    const now = context.clock.now().toISOString();
    await context.services.db
      .insertInto("parcels")
      .values({
        id: crypto.randomUUID(),
        carrier: "fakepost",
        tracking_number: CODE,
        direction: "receiving",
        status: "in_transit",
        raw_status: "Moving",
        delivered: 0,
        pickup: 0,
        label: null,
        first_seen_at: now,
        last_seen_at: now,
        updated_at: now,
      })
      .execute();

    await context.services.runner.run(fromShop);

    const parcels = await context.services.db
      .selectFrom("parcels")
      .select(["id", "carrier", "manual_status", "manual_at"])
      .execute();
    expect(parcels).toHaveLength(1);
    expect(parcels[0]).toMatchObject({
      carrier: "fakepost",
      manual_status: "in_transit",
      manual_at: "2026-11-18T11:00:00.000Z",
    });
    const raw = await context.services.db
      .selectFrom("parcel_raw")
      .select(["parcel_id", "payload"])
      .execute();
    expect(raw).toEqual([{ parcel_id: parcels[0]?.id, payload: '{"order":"made-up"}' }]);
  });
});
