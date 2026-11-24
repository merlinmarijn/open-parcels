import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../helpers.js";

let context: TestContext;

beforeEach(async () => {
  context = await createTestContext();
});
afterEach(async () => {
  await context.close();
});

async function lastUsed(): Promise<string | null | undefined> {
  return (
    await context.services.db.selectFrom("api_tokens").select("last_used_at").executeTakeFirst()
  )?.last_used_at;
}

describe("API token use", () => {
  it("records a use at most once a minute, and the stream check records none (OP-068)", async () => {
    const { auth } = context.services;
    const { token, info } = await auth.createToken("ha", ["read"], null);
    await auth.findToken(token);
    const first = await lastUsed();
    expect(first).toBe(context.clock.now().toISOString());

    context.clock.advance(30_000);
    await auth.findToken(token);
    expect(await lastUsed()).toBe(first);

    context.clock.advance(31_000);
    expect(await auth.tokenAlive(token)).toBe(info.id);
    expect(await lastUsed()).toBe(first);
    await auth.findToken(token);
    expect(await lastUsed()).toBe(context.clock.now().toISOString());
  });
});
