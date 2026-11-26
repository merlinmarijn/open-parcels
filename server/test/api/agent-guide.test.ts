import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, READER_PASSWORD, type TestContext } from "../helpers.js";

let context: TestContext;

beforeEach(async () => {
  // Reading needs a login here: the guide must load anyway.
  context = await createTestContext({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
});
afterEach(async () => {
  await context.close();
});

describe("/llms.txt", () => {
  it("serves the agent guide as Markdown without a login", async () => {
    const app = await context.app();
    const response = await app.inject({ method: "GET", url: "/llms.txt" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(response.body).toMatch(/^# open-parcels: guide for AI agents/);
    for (const path of ["/api/v1/email-lab/test", "/api/v1/email-rules", "/api/v1/events"]) {
      expect(response.body).toContain(path);
    }
  });
});
