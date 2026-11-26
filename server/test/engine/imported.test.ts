import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRetention } from "../../src/engine/retention.js";
import { snapshot } from "../../src/provider/api.js";
import { fakeJobs, JobWorld } from "../fakes/jobs.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

/** What an import job stores is history: flagged, quiet, archived when old, and kept. */

const DAY = 24 * 60 * 60 * 1000;
let context: TestContext;
let connectionId: string;

beforeEach(async () => {
  context = await createTestContext({ providers: [fakeJobs(new JobWorld())] });
  const app = await context.app();
  const session = await signIn(context, app);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/connections",
    headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
    payload: { provider: "fakejobs", kind: "account", label: "Shop", config: {} },
  });
  connectionId = response.json<{ id: string }>().id;
});

afterEach(async () => {
  await context.close();
});

const daysAgo = (days: number): string =>
  new Date(context.clock.now().getTime() - days * DAY).toISOString();

function moving(trackingNumber: string) {
  return snapshot({
    carrier: "fakejobs",
    trackingNumber,
    status: "in_transit",
    rawStatus: "On its way",
  });
}

function delivered(trackingNumber: string, days: number) {
  return snapshot({
    carrier: "fakejobs",
    trackingNumber,
    status: "delivered",
    rawStatus: "Delivered",
    deliveredAt: daysAgo(days),
    order: {
      shop: "fakeshop",
      orderNumber: `ORDER-${trackingNumber}`,
      placedAt: daysAgo(days + 3),
    },
  });
}

async function outbox(): Promise<
  { type: string; parcelId: string | null; payload: Record<string, unknown> }[]
> {
  const rows = await context.services.db
    .selectFrom("outbox")
    .select(["type", "parcel_id", "payload"])
    .where("type", "not like", "connection.%")
    .orderBy("seq")
    .execute();
  return rows.map((row) => ({
    type: row.type,
    parcelId: row.parcel_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  }));
}

describe("imported history", () => {
  it("flags what it stores, archives old deliveries without events and sums up the batch", async () => {
    await context.services.reconciler.ingest(
      connectionId,
      {
        snapshots: [delivered("IMPORT0001", 400), moving("IMPORT0002")],
        orders: [
          {
            order: { shop: "fakeshop", orderNumber: "ORDER-ONLY" },
            status: "delivered",
            at: daysAgo(900),
            items: ["Example lamp"],
            total: null,
            payment: false,
          },
        ],
        complete: false,
      },
      [],
      { imported: true },
    );
    const parcels = await context.services.db
      .selectFrom("parcels")
      .select(["id", "tracking_number", "imported_at", "archived_at"])
      .orderBy("tracking_number")
      .execute();
    const now = context.clock.now().toISOString();
    expect(
      parcels.map((parcel) => [parcel.tracking_number, parcel.imported_at, parcel.archived_at]),
    ).toEqual([
      ["IMPORT0001", now, now],
      ["IMPORT0002", now, null],
    ]);
    const orders = await context.services.db
      .selectFrom("orders")
      .select(["order_number", "imported_at"])
      .orderBy("order_number")
      .execute();
    expect(orders.every((order) => order.imported_at === now)).toBe(true);
    expect(orders).toHaveLength(2);

    const events = await outbox();
    // The old delivery fires nothing; the moving parcel and the orders fire, marked imported.
    expect(events.filter((event) => event.parcelId === parcels[0]?.id)).toEqual([]);
    expect(events.some((event) => event.parcelId === parcels[1]?.id)).toBe(true);
    expect(events.at(-1)?.type).toBe("parcel.imported");
    expect(events.every((event) => event.payload["imported"] === true)).toBe(true);
    expect(events.at(-1)?.payload).toMatchObject({
      connection: { id: connectionId, provider: "fakejobs" },
      created: 2,
      updated: 0,
      archived: 1,
      orders: 1,
    });
  });

  it("leaves runs' events unmarked, and retention never deletes imported parcels", async () => {
    await context.services.reconciler.ingest(connectionId, {
      snapshots: [delivered("POLLED0001", 400), moving("POLLED0002")],
      complete: false,
    });
    await context.services.reconciler.ingest(
      connectionId,
      { snapshots: [delivered("IMPORT0001", 400)], complete: false },
      [],
      { imported: true },
    );
    const polled = (await outbox()).filter((event) => event.type === "parcel.registered");
    expect(polled.map((event) => event.payload["imported"])).toEqual([undefined]);

    const policy = {
      archiveAfterDays: 30,
      deleteAfterDays: 30,
      rawAfterDays: 30,
      notFoundArchiveDays: 0,
    };
    await applyRetention(context.services.db, context.clock, policy);
    context.clock.advance(60 * DAY);
    expect(await applyRetention(context.services.db, context.clock, policy)).toMatchObject({
      deleted: 1,
    });
    const left = await context.services.db
      .selectFrom("parcels")
      .select("tracking_number")
      .execute();
    expect(left.map((row) => row.tracking_number).sort()).toEqual(["IMPORT0001", "POLLED0002"]);
  });
});
