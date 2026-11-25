import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { BUILTIN_CARRIERS } from "../../src/engine/builtin-carriers.js";
import { loadLogos } from "../../src/logos.js";
import { FakeWorld, fakePost, fakeShop } from "../fakes/carriers.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

const LOGO_DIR = new URL("../../logos/", import.meta.url);

let context: TestContext;
let app: App;
let headers: Record<string, string>;

beforeEach(async () => {
  const world = new FakeWorld();
  const post = fakePost(world);
  context = await createTestContext({
    providers: [
      { ...post, info: { ...post.info, logo: "dhl.svg", aliases: ["Fake Mail"] } },
      fakeShop(world),
    ],
  });
  app = await context.app();
  const session = await signIn(context, app);
  headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
});
afterEach(async () => {
  await context.close();
});

interface ListedCarrier {
  readonly id: string;
  readonly aliases: string[];
  readonly logo: string | null;
}

describe("provider logos", () => {
  it("lists aliases and a content-hashed logo path, null without a logo", async () => {
    const carriers = (await app.inject({ url: "/api/v1/carriers", headers })).json<
      ListedCarrier[]
    >();
    const post = carriers.find((carrier) => carrier.id === "fakepost");
    const shop = carriers.find((carrier) => carrier.id === "fakeshop");
    expect(post?.aliases).toEqual(["Fake Mail"]);
    expect(post?.logo).toMatch(/^\/api\/v1\/carriers\/fakepost\/logo\?v=[0-9a-f]{12}$/);
    expect(shop).toMatchObject({ aliases: [], logo: null });
  });

  it("serves the logo without a login, cached for good under its hash", async () => {
    const carriers = (await app.inject({ url: "/api/v1/carriers", headers })).json<
      ListedCarrier[]
    >();
    const path = carriers.find((carrier) => carrier.id === "fakepost")?.logo ?? "";
    const response = await app.inject({ url: path });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/svg+xml");
    expect(response.headers["cache-control"]).toContain("immutable");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.body).toContain("<svg");

    const stale = await app.inject({ url: "/api/v1/carriers/fakepost/logo?v=old" });
    expect(stale.headers["cache-control"]).toBe("no-cache");
  });

  it("answers 404 for a provider without a logo or an unknown one", async () => {
    for (const id of ["fakeshop", "nosuch"]) {
      const response = await app.inject({ url: `/api/v1/carriers/${id}/logo` });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe("the bundled logos", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", LOGO_DIR), "utf8")) as Record<
    string,
    { file: string; source: string; license: string }
  >;
  const files = readdirSync(LOGO_DIR).filter((file) => file !== "manifest.json");

  it("exist for every built-in provider that names one", () => {
    const logos = loadLogos();
    for (const provider of BUILTIN_CARRIERS) {
      if (provider.info.logo !== null) {
        expect(logos.has(provider.info.logo), provider.info.id).toBe(true);
      }
    }
  });

  it("each have a source and licence in the manifest", () => {
    const listed = Object.values(manifest).map((entry) => entry.file);
    expect([...listed].sort()).toEqual([...files].sort());
    for (const entry of Object.values(manifest)) {
      expect(entry.source).not.toBe("");
      expect(entry.license).not.toBe("");
    }
  });

  it("load nothing from elsewhere (no external references, no scripts)", () => {
    for (const file of files.filter((name) => name.endsWith(".svg"))) {
      const svg = readFileSync(new URL(file, LOGO_DIR), "utf8");
      expect(svg, file).not.toMatch(/<script|href=|url\(|on[a-z]+=/i);
    }
  });
});
