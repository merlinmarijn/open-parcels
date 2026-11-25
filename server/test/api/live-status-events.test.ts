import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HealthWatch } from "../../src/status/health-watch.js";
import { FakeWorld, fakePost } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

let context: TestContext;

beforeEach(async () => {
  context = await createTestContext({ providers: [fakePost(new FakeWorld())] });
});
afterEach(async () => {
  await context.close();
});

async function stored(type: string): Promise<unknown[]> {
  const rows = await context.services.db
    .selectFrom("outbox")
    .select("payload")
    .where("type", "=", type)
    .execute();
  return rows.map((row) => JSON.parse(row.payload) as unknown);
}

describe("live events that replace polling", () => {
  it("announces a token's use once per touch interval", async () => {
    const app = await context.app();
    const { token, info } = await context.services.auth.createToken("t", ["read"], null);
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ url: "/api/v1/parcels", headers })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/parcels", headers })).statusCode).toBe(200);
    expect(await stored("token.used")).toEqual([
      { kind: "token", id: info.id, last_used_at: expect.any(String) as unknown },
    ]);
  });

  it("announces a change of the server's health, not every check", async () => {
    const watch = new HealthWatch(context.services);
    expect(await watch.checkOnce()).toBe(false);
    expect(await watch.checkOnce()).toBe(false);
    const connection = await context.services.connections.create({
      provider: "fakepost",
      kind: "tracking",
      label: "t",
      config: {},
      secret: null,
    });
    await context.services.db
      .updateTable("connections")
      .set({ state: "error" })
      .where("id", "=", connection.id)
      .execute();
    expect(await watch.checkOnce()).toBe(true);
    expect(await watch.checkOnce()).toBe(false);
    expect(await stored("health.changed")).toEqual([
      expect.objectContaining({ status: "degraded" }),
    ]);
  });
});
