import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderOpenApiDocument } from "../../src/api/openapi-document.js";

describe("docs/openapi.json", () => {
  it("matches the API the server serves (regenerate with `npm run openapi -w server`)", async () => {
    const committed = readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8");
    expect(await renderOpenApiDocument()).toBe(committed.replaceAll("\r\n", "\n"));
  });
});
