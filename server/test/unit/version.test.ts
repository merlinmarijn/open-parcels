import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serviceUserAgent } from "../../src/services.js";
import { userAgent, VERSION } from "../../src/version.js";

describe("the version (OP-056)", () => {
  it("is the package's, and every User-Agent names it", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
    expect(userAgent()).toBe(
      `open-parcels/${VERSION} (+https://github.com/open-parcels/open-parcels)`,
    );
    expect(serviceUserAgent("ops@example.invalid")).toBe(
      `open-parcels/${VERSION} (self-hosted parcel tracker; +https://github.com/open-parcels/open-parcels; ops@example.invalid)`,
    );
  });
});
