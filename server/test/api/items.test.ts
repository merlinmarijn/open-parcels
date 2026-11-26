import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { demoCarrier } from "../../src/carriers/demo/index.js";
import { demoShop } from "../../src/carriers/demo_shop/index.js";
import { registerBuiltin } from "../manifests.js";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CollageMaker, gridFor } from "../../src/images/collage.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

/* Pictures are made up on the spot; no network is used. */

let context: TestContext;
let app: App;
let headers: Record<string, string>;

/** A small PNG in one colour, standing in for a shop's item picture. */
async function png(): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .png()
    .toBuffer();
}

beforeEach(async () => {
  const picture = await png();
  context = await createTestContext({
    providers: [registerBuiltin(demoCarrier), registerBuiltin(demoShop)],
    fetchImpl: () =>
      Promise.resolve(new Response(picture, { headers: { "content-type": "image/png" } })),
  });
  app = await context.app();
  const session = await signIn(context, app);
  headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
  for (const provider of ["demo_shop", "demo"] as const) {
    const connection = await context.services.connections.create({
      provider,
      kind: provider === "demo" ? "account" : "shop",
      label: provider,
      config: {},
      secret: null,
    });
    await context.services.runner.run(connection.id);
  }
});
afterEach(async () => {
  await context.close();
});

interface ParcelBody {
  id: string;
  tracking_number: string;
  display_name: string;
  items: { title: string }[];
  order: { order_number: string; items: { title: string; parcel_id: string | null }[] } | null;
}

async function parcel(trackingNumber: string): Promise<ParcelBody> {
  const list = (await app.inject({ url: "/api/v1/parcels?limit=50", headers })).json<
    ParcelBody[] | { items: ParcelBody[] }
  >();
  const found = (Array.isArray(list) ? list : list.items).find(
    (p) => p.tracking_number === trackingNumber,
  );
  if (found === undefined) throw new Error(`no ${trackingNumber}`);
  return (await app.inject({ url: `/api/v1/parcels/${found.id}`, headers })).json<ParcelBody>();
}

describe("items on orders and parcels", () => {
  it("lists the whole order, links lines to their parcel and keeps unplaced ones on the order", async () => {
    const lamp = await parcel("DEMO0000000002");
    expect(lamp.items.map((item) => item.title)).toEqual(["Desk lamp"]);
    expect(lamp.order?.order_number).toBe("DEMO-1001");
    const lines = lamp.order?.items ?? [];
    expect(lines.map((line) => line.title)).toEqual([
      "Coffee mug, blue",
      "Tea towel",
      "Desk lamp",
      "Gift voucher, 20 EUR",
    ]);
    expect(lines.find((line) => line.title === "Desk lamp")?.parcel_id).toBe(lamp.id);
    expect(lines.find((line) => line.title === "Gift voucher, 20 EUR")?.parcel_id).toBeNull();
  });

  it("names parcels after their items when asked, else by their tracking code", async () => {
    expect((await parcel("DEMO0000000001")).display_name).toBe("DEMO0000000001");
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/parcel-label",
      headers,
      payload: { parcel_label: "items" },
    });
    expect(put.json()).toMatchObject({ parcel_label: "items" });
    expect((await parcel("DEMO0000000001")).display_name).toBe("Coffee mug, blue, Tea towel");
    const settings = await context.services.db
      .selectFrom("outbox")
      .select("type")
      .where("type", "=", "settings.updated")
      .execute();
    expect(settings).toHaveLength(1);
  });

  it("draws the item pictures as one square picture", async () => {
    const mugs = await parcel("DEMO0000000001");
    const picture = await app.inject({ url: `/api/v1/parcels/${mugs.id}/picture`, headers });
    expect(picture.statusCode).toBe(200);
    expect(picture.headers["content-type"]).toBe("image/png");
    const meta = await sharp(picture.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([256, 256]);
  });
});

describe("image proxy paths", () => {
  it("accepts the long paths of long picture addresses (no 414)", async () => {
    const response = await app.inject({
      url: `/img/${"a".repeat(600)}.${"b".repeat(32)}`,
      headers,
    });
    expect(response.statusCode).not.toBe(414);
  });
});

describe("gridFor", () => {
  // The grid is square: gridFor returns its side, the number of rows and of columns.
  it.each([
    { count: 1, side: 1 },
    { count: 2, side: 2 },
    { count: 4, side: 2 },
    { count: 5, side: 3 },
    { count: 9, side: 3 },
    { count: 12, side: 3 },
  ])("puts $count pictures in a $side×$side grid", ({ count, side }) => {
    expect(gridFor(count)).toBe(side);
  });
});

describe("CollageMaker", () => {
  it("keeps only complete collages and prunes old ones (OP-029)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "op-collages-"));
    try {
      let now = Date.now();
      const maker = new CollageMaker(dir, () => now);
      const picture = await png();
      let failing = true;
      const load = (name: string) => Promise.resolve(failing && name === "b" ? null : picture);
      // One picture failed: the collage is drawn but not kept, so the next call tries again.
      expect(await maker.make(["a", "b"], load)).not.toBeNull();
      expect(await readdir(dir)).toEqual([]);
      failing = false;
      await maker.make(["a", "b"], load);
      const files = await readdir(dir);
      expect(files).toHaveLength(1);

      expect(await maker.prune()).toBe(0);
      const old = new Date(now - 31 * 24 * 60 * 60 * 1000);
      await utimes(path.join(dir, files[0] ?? ""), old, old);
      now += 1;
      expect(await maker.prune()).toBe(1);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
