import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordUnknown } from "../../src/engine/vocab.js";
import { createTestContext, type TestContext } from "../helpers.js";

let context: TestContext;

beforeEach(async () => {
  context = await createTestContext();
});
afterEach(async () => {
  await context.close();
});

describe("recordUnknown", () => {
  it("counts a new value reported by two writers at once, announcing it once (OP-033)", async () => {
    const { services } = context;
    const value = { provider: "fakepost", kind: "status", key: "MADE-UP" };
    await Promise.all([
      recordUnknown(services, value, services.logger),
      recordUnknown(services, value, services.logger),
    ]);
    const row = await services.db.selectFrom("unknown_vocab").selectAll().executeTakeFirst();
    expect(row?.count).toBe(2);
    const events = await services.db
      .selectFrom("outbox")
      .select("type")
      .where("type", "=", "vocab.unknown")
      .execute();
    expect(events).toHaveLength(1);
  });
});
