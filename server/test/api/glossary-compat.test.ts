import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { legacyTwin } from "../../src/events/legacy.js";
import { FakeWorld, fakeShop } from "../fakes/carriers.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

/** The old names the glossary rename keeps working for one release (docs/glossary.md). */
let context: TestContext;
let app: App;

beforeEach(async () => {
  context = await createTestContext({ providers: [fakeShop(new FakeWorld())] });
  app = await context.app();
});
afterEach(async () => {
  await context.close();
});

describe("deprecated names in the REST API", () => {
  it("accepts `barcode` and `outgoing` and sends the old fields next to the new ones", async () => {
    const session = await signIn(context, app);
    const headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers,
      payload: { carrier: "hermes", barcode: "H0000000000000000007", direction: "outgoing" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      tracking_number: "H0000000000000000007",
      barcode: "H0000000000000000007",
      direction: "sending",
      legacy_direction: "outgoing",
      expected_from: null,
      planned_from: null,
      expected_days: null,
    });
  });

  it("refuses a parcel without a tracking number", async () => {
    const session = await signIn(context, app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
      payload: { carrier: "hermes" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("serves /api/v1/sources as /api/v1/connections and takes `plugin` for `provider`", async () => {
    const session = await signIn(context, app);
    const headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers,
      payload: { plugin: "fakeshop", kind: "shop", label: "Made-up shop" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ provider: "fakeshop", plugin: "fakeshop" });
    const listed = await app.inject({ url: "/api/v1/sources", headers });
    expect(listed.json<{ id: string }[]>().map((row) => row.id)).toEqual([
      created.json<{ id: string }>().id,
    ]);
    const carriers = await app.inject({ url: "/api/v1/carriers", headers });
    const [shop] = carriers.json<{ connection_kinds: string[]; source_kinds: string[] }[]>();
    expect(shop?.connection_kinds).toEqual(["shop"]);
    expect(shop?.source_kinds).toEqual(["shop"]);
  });
});

describe("deprecated live event names", () => {
  it("twins a renamed live event under its old name with `source` next to `connection`", () => {
    const connection = { id: "c-1", provider: "dhl", label: "DHL tracking", kind: "tracking" };
    expect(legacyTwin({ type: "connection.added", payload: { connection, state: "ok" } })).toEqual({
      type: "source.added",
      payload: { connection, source: { ...connection, plugin: "dhl" }, state: "ok" },
    });
    expect(legacyTwin({ type: "parcel.sending_delivered", payload: {} })).toEqual({
      type: "parcel.outgoing_delivered",
      payload: {},
    });
    expect(legacyTwin({ type: "parcel.delivered", payload: {} })).toBeUndefined();
  });
});
