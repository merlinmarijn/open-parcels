import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeUrl } from "../../src/engine/links.js";
import { FakeWorld, fakePost, snapshot } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* Links on parcels and items. Every address is made up. */

describe("a stored link", () => {
  it("is only ever http or https", () => {
    expect(safeUrl("https://track.example.invalid/x?y=1")).toBe(
      "https://track.example.invalid/x?y=1",
    );
    expect(safeUrl(" http://track.example.invalid/ ")).toBe("http://track.example.invalid/");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,hi")).toBeNull();
    expect(safeUrl("/relative/path")).toBeNull();
  });

  describe("from a carrier", () => {
    let context: TestContext;
    let post: FakeWorld;

    beforeEach(async () => {
      post = new FakeWorld();
      context = await createTestContext({ providers: [fakePost(post)] });
    });
    afterEach(async () => {
      await context.close();
    });

    it("is dropped when it uses another scheme", async () => {
      post.listing = [
        snapshot({
          carrier: "fakepost",
          trackingNumber: "FP0000000088",
          status: "in_transit",
          rawStatus: "x",
          url: "javascript:alert(1)",
          items: [
            {
              title: "Kettle",
              imageUrl: "data:image/png;base64,AAAA",
              url: "vbscript:x",
              externalId: null,
              quantity: 1,
              price: null,
              currency: null,
            },
          ],
          // Order lines too (OP-008).
          order: { shop: "example-shop.de", orderNumber: "100001", placedAt: null },
          orderItems: [
            {
              title: "Kettle",
              imageUrl: "data:image/png;base64,AAAA",
              url: "javascript:alert(2)",
              externalId: null,
              quantity: 1,
              price: null,
              currency: null,
            },
          ],
        }),
      ];
      const connection = await context.services.connections.create({
        provider: "fakepost",
        kind: "account",
        label: "account",
        config: {},
        secret: { username: "user@example.invalid", password: ["p", "q"].join("-") },
      });
      await context.services.runner.run(connection.id);
      const parcel = await context.services.db
        .selectFrom("parcels")
        .select("url")
        .executeTakeFirstOrThrow();
      expect(parcel.url).toBeNull();
      const item = await context.services.db
        .selectFrom("items")
        .select(["url", "image_ref"])
        .executeTakeFirstOrThrow();
      expect(item).toEqual({ url: null, image_ref: null });
      const line = await context.services.db
        .selectFrom("order_items")
        .select(["url", "image_ref"])
        .executeTakeFirstOrThrow();
      expect(line).toEqual({ url: null, image_ref: null });
    });
  });
});
