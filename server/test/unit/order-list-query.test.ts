import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORDER_VIEWS, inView, type Order } from "../../src/domain/order-lifecycle.js";
import { newParcelRow } from "../../src/parcels/new-row.js";
import { createTestContext, type TestContext } from "../helpers.js";

let context: TestContext;

beforeEach(async () => {
  context = await createTestContext();
});
afterEach(async () => {
  await context.close();
});

/** A small fixed-seed generator, so a failure always reproduces. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

const PARCEL_STATUSES = [
  "registered",
  "unknown",
  "in_transit",
  "out_for_delivery",
  "at_pickup_point",
  "delivered",
  "problem",
  "returning",
] as const;
const REPORTED = [null, "ordered", "shipped", "delivered", "cancelled", "refunded"] as const;
const MODES = [null, null, null, "archived", "kept"] as const;

describe("the order list's SQL page", () => {
  it("puts every order in the views its built status and archiving say", async () => {
    const next = random(7);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
    const now = context.clock.now();
    const day = (offset: number): string =>
      new Date(now.getTime() + offset * 86_400_000).toISOString();
    const db = context.services.db;
    for (let n = 0; n < 300; n += 1) {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const mode = pick(MODES);
      await db
        .insertInto("orders")
        .values({
          id,
          shop: "example",
          order_number: `O-${String(n)}`,
          placed_at: next() < 0.2 ? null : day(-Math.floor(next() * 60)),
          status: pick(REPORTED),
          created_at: day(-Math.floor(next() * 60)),
          updated_at: day(-1),
          archive_mode: mode,
          archived_at: mode === "archived" ? day(-2) : null,
        })
        .execute();
      const parcels = Math.floor(next() * 4);
      for (let p = 0; p < parcels; p += 1) {
        const status = pick(PARCEL_STATUSES);
        const manual = next() < 0.15 ? pick(PARCEL_STATUSES) : null;
        await db
          .insertInto("parcels")
          .values(
            newParcelRow(
              {
                id: crypto.randomUUID(),
                carrier: "example",
                trackingNumber: `T${String(n)}X${String(p)}`,
                direction: "receiving",
                now: day(-5),
              },
              {
                status,
                delivered: status === "delivered" ? 1 : 0,
                manual_status: manual,
                order_id: id,
                archived_at: next() < 0.4 ? day(-Math.floor(next() * 10)) : null,
              },
            ),
          )
          .execute();
      }
    }
    const all: Order[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await context.services.orders.list({ view: "all", limit: 100, offset });
      all.push(...page.orders);
      if (!page.more) break;
    }
    expect(all).toHaveLength(300);
    for (const view of ORDER_VIEWS) {
      const listed = await context.services.orders.list({ view, limit: 1000, offset: 0 });
      const expected = all.filter((order) => inView(view, order.status, order.archived));
      expect(
        listed.orders.map((order) => order.id),
        view,
      ).toEqual(expected.map((order) => order.id));
    }
  });
});
