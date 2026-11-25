import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { demoCarrier, demoShop } from "../../src/carriers/demo/index.js";
import { register } from "../../src/engine/registry.js";
import type { SyncPage } from "../../src/sync/service.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

let context: TestContext;
let app: App;
let headers: Record<string, string>;
let shopConnection: string;

beforeEach(async () => {
  context = await createTestContext({ providers: [register(demoCarrier), register(demoShop)] });
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
  // The demo shop reports no scans: give every parcel two made-up events.
  const parcels = await context.services.db.selectFrom("parcels").select("id").execute();
  for (const { id } of parcels) {
    for (const [index, at] of ["2026-11-17T08:00:00.000Z", "2026-11-17T12:00:00.000Z"].entries()) {
      await context.services.db
        .insertInto("parcel_events")
        .values({
          parcel_id: id,
          // No connection: the shop's runs keep them (they drop only their own scans).
          connection_id: null,
          at,
          status: "in_transit",
          raw_status: "Made-up scan",
          location_text: null,
          fingerprint: `${id}-${String(index)}`,
        })
        .execute();
    }
  }
});
afterEach(async () => {
  await context.close();
});

type Page = Omit<SyncPage, "connections"> & { connections: { id: string; label: string }[] };

async function sync(since = "0", limit?: number): Promise<Page> {
  const query = new URLSearchParams({ since });
  if (limit !== undefined) query.set("limit", String(limit));
  const response = await app.inject({ url: `/api/v1/sync?${query.toString()}`, headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Page>();
}

/** Follows `more` to the end, as a client does. */
async function syncAll(since = "0", limit?: number): Promise<{ pages: Page[]; cursor: string }> {
  const pages: Page[] = [];
  let cursor = since;
  for (;;) {
    const page = await sync(cursor, limit);
    pages.push(page);
    cursor = page.cursor;
    if (!page.more) return { pages, cursor };
  }
}

async function patch(url: string, payload: Record<string, unknown>): Promise<void> {
  const response = await app.inject({ method: "PATCH", url, headers, payload });
  expect(response.statusCode, response.body).toBe(200);
}

describe("GET /api/v1/sync", () => {
  it("returns everything from the start, then nothing until something changes", async () => {
    const { pages, cursor } = await syncAll();
    const first = pages[0];
    if (first === undefined) throw new Error("no page");
    expect(first.connections.map((entry) => entry.id)).toContain(shopConnection);
    expect(first.parcels.length).toBeGreaterThan(0);
    expect(first.orders.length).toBeGreaterThan(0);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.deleted).toEqual([]);
    expect(first.parcels[0]).not.toHaveProperty("history");
    expect(JSON.stringify(first.connections)).not.toContain("secret_blob");

    const idle = await sync(cursor);
    expect(idle).toMatchObject({ cursor, more: false, parcels: [], orders: [], deleted: [] });

    const parcel = first.parcels[0];
    if (parcel === undefined) throw new Error("no parcel");
    await patch(`/api/v1/parcels/${parcel.id}`, { label: "Made-up label" });
    const changed = await sync(cursor);
    expect(changed.parcels.map((entry) => entry.id)).toContain(parcel.id);
    expect(changed.parcels.find((entry) => entry.id === parcel.id)?.label).toBe("Made-up label");
    expect(Number(changed.cursor)).toBeGreaterThan(Number(cursor));
  });

  it("pages without repeating or skipping anything", async () => {
    const whole = await sync("0", 1000);
    const total =
      whole.parcels.length +
      whole.events.length +
      whole.orders.length +
      whole.returns.length +
      whole.connections.length;
    const { pages } = await syncAll("0", 2);
    expect(pages.length).toBeGreaterThan(1);
    const ids = pages.flatMap((page) => [
      ...page.parcels.map((entry) => `parcel:${entry.id}`),
      ...page.events.map((entry) => `event:${entry.id}`),
      ...page.orders.map((entry) => `order:${entry.id}`),
      ...page.returns.map((entry) => `return:${entry.id}`),
      ...page.connections.map((entry) => `connection:${entry.id}`),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(total);
  });

  it("reports deletions as tombstones, written by the deleting transaction", async () => {
    const { pages, cursor } = await syncAll();
    const parcel = pages[0]?.parcels.find((entry) => entry.order === null) ?? pages[0]?.parcels[0];
    if (parcel === undefined) throw new Error("no parcel");
    const order = pages[0]?.orders[0];
    if (order === undefined) throw new Error("no order");

    const deleteOrder = await app.inject({
      method: "DELETE",
      url: `/api/v1/orders/${order.id}`,
      headers,
    });
    expect(deleteOrder.statusCode).toBe(204);
    const deleteParcel = await app.inject({
      method: "DELETE",
      url: `/api/v1/parcels/${parcel.id}`,
      headers,
    });
    expect(deleteParcel.statusCode).toBe(204);

    const after = await sync(cursor, 1000);
    expect(after.deleted).toEqual(
      expect.arrayContaining([
        { type: "order", id: order.id },
        { type: "parcel", id: parcel.id },
      ]),
    );
    const eventTombstones = after.deleted.filter((entry) => entry.type === "event");
    expect(eventTombstones.length).toBeGreaterThan(0);
    expect(after.parcels.map((entry) => entry.id)).not.toContain(parcel.id);
  });

  it("reports what a disabled connection hides as deleted, and brings it back when enabled", async () => {
    const { pages, cursor } = await syncAll();
    const parcelIds = pages.flatMap((page) => page.parcels.map((entry) => entry.id));
    await patch(`/api/v1/connections/${shopConnection}`, { enabled: false });
    const hidden = await syncAll(cursor, 1000);
    const deleted = hidden.pages.flatMap((page) => page.deleted);
    expect(deleted).toEqual(
      expect.arrayContaining(parcelIds.map((id) => ({ type: "parcel", id }))),
    );
    await patch(`/api/v1/connections/${shopConnection}`, { enabled: true });
    const shown = await syncAll(hidden.cursor, 1000);
    const back = shown.pages.flatMap((page) => page.parcels.map((entry) => entry.id));
    expect(back).toEqual(expect.arrayContaining(parcelIds));
    expect(shown.pages.flatMap((page) => page.events).length).toBeGreaterThan(0);
  });

  it("refuses a cursor older than the kept tombstones or newer than the data", async () => {
    const { cursor } = await syncAll();
    const tooNew = await app.inject({
      url: `/api/v1/sync?since=${String(Number(cursor) + 1000)}`,
      headers,
    });
    expect(tooNew.statusCode).toBe(410);
    expect(tooNew.json()).toMatchObject({ error: "sync_expired" });

    const parcel = (await sync()).parcels[0];
    if (parcel === undefined) throw new Error("no parcel");
    await app.inject({ method: "DELETE", url: `/api/v1/parcels/${parcel.id}`, headers });
    // Tombstones carry the database's own time: move the cut-off past it.
    context.clock.advance(Date.now() - context.clock.now().getTime() + 91 * 24 * 60 * 60 * 1000);
    expect(await context.services.sync.pruneTombstones()).toBeGreaterThan(0);
    const stale = await app.inject({ url: `/api/v1/sync?since=${cursor}`, headers });
    expect(stale.statusCode).toBe(410);
    expect((await sync("0", 1000)).deleted.map((entry) => entry.id)).not.toContain(parcel.id);
  });

  it("does not count a provider run that changed nothing", async () => {
    // The first run after the made-up events takes their status over: a real change.
    await context.services.runner.run(shopConnection);
    const { cursor } = await syncAll();
    await context.services.runner.run(shopConnection);
    const after = await sync(cursor, 1000);
    expect(after.parcels).toEqual([]);
    expect(after.orders).toEqual([]);
    expect(after.events).toEqual([]);
  });
});
