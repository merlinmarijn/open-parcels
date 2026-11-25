import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  availableLayers,
  BUILTIN_LAYERS,
  builtinLayers,
  customLayer,
  EOX_CLOUDLESS_YEAR,
  templateProblem,
  tileUrl,
  wmtsBaseProblem,
} from "../../src/tiles/layers.js";
import {
  cacheMeta,
  DEFAULT_FRESH_MS,
  TileError,
  TileProxy,
  validTile,
} from "../../src/tiles/proxy.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function png(): Response {
  return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
}

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

describe("tile proxy", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "op-tiles-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts only real tile coordinates", () => {
    expect(validTile(0, 0, 0)).toBe(true);
    expect(validTile(2, 3, 3)).toBe(true);
    expect(validTile(2, 4, 0)).toBe(false);
    expect(validTile(20, 0, 0)).toBe(false);
    expect(validTile(-1, 0, 0)).toBe(false);
  });

  it("identifies itself upstream, caches, and serves the cache next time", async () => {
    const calls: { url: string; agent: string | null }[] = [];
    const proxy = new TileProxy({
      cacheDir: dir,
      userAgent: () => "open-parcels/test",
      fetchImpl: (input, init) => {
        calls.push({ url: urlOf(input), agent: new Headers(init.headers).get("user-agent") });
        return Promise.resolve(png());
      },
    });
    const first = await proxy.get("osm", 3, 4, 5);
    expect(first).toEqual({ body: PNG, cached: false, contentType: "image/png" });
    expect(calls).toEqual([
      { url: "https://tile.openstreetmap.org/3/4/5.png", agent: "open-parcels/test" },
    ]);
    const second = await proxy.get("osm", 3, 4, 5);
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("caches each layer apart, with its own format", async () => {
    const urls: string[] = [];
    const proxy = new TileProxy({
      cacheDir: dir,
      userAgent: () => "t",
      fetchImpl: (input) => {
        urls.push(urlOf(input));
        return Promise.resolve(png());
      },
    });
    await proxy.get("osm", 2, 1, 3);
    const satellite = await proxy.get("satellite", 2, 1, 3);
    expect(satellite.contentType).toBe("image/jpeg");
    // WMTS order: z / row (y) / column (x).
    expect(urls[1]).toBe(
      `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${String(EOX_CLOUDLESS_YEAR)}_3857/default/GoogleMapsCompatible/2/3/1.jpg`,
    );
    await stat(path.join(dir, "osm", "2", "1", "3.png"));
    await stat(path.join(dir, `s2cloudless-${String(EOX_CLOUDLESS_YEAR)}`, "2", "1", "3.jpg"));
    await proxy.get("satellite", 2, 1, 3);
    expect(urls).toHaveLength(2);
  });

  it("refuses unknown layers and bad coordinates without any request", async () => {
    let called = false;
    const proxy = new TileProxy({
      cacheDir: dir,
      userAgent: () => "t",
      fetchImpl: () => {
        called = true;
        return Promise.resolve(png());
      },
    });
    await expect(proxy.get("osm", 1, 5, 0)).rejects.toBeInstanceOf(TileError);
    await expect(proxy.get("custom", 1, 0, 0)).rejects.toMatchObject({ statusCode: 404 });
    await expect(proxy.get("../etc", 1, 0, 0)).rejects.toMatchObject({ statusCode: 404 });
    // Deeper than the layer serves.
    await expect(proxy.get("topo", 18, 0, 0)).rejects.toMatchObject({ statusCode: 400 });
    expect(called).toBe(false);
  });

  it("serves a stale tile when the tile server refuses, and fails without one", async () => {
    let refuse = false;
    const proxy = new TileProxy({
      cacheDir: dir,
      userAgent: () => "t",
      fetchImpl: () => Promise.resolve(refuse ? new Response("blocked", { status: 403 }) : png()),
    });
    await proxy.get("osm", 1, 1, 1);
    const file = path.join(dir, "osm", "1", "1", "1.png");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(file, old, old);
    refuse = true;
    await expect(proxy.get("osm", 1, 1, 1)).resolves.toMatchObject({ body: PNG, cached: true });
    await expect(proxy.get("osm", 1, 0, 0)).rejects.toMatchObject({ statusCode: 502 });
  });

  it("serves a stale tile at once and refreshes it behind, pausing the layer after a failure (OP-028)", async () => {
    let calls = 0;
    let upstream: () => Promise<Response> = () => Promise.resolve(png());
    let now = Date.now();
    const proxy = new TileProxy({
      cacheDir: dir,
      userAgent: () => "t",
      now: () => now,
      fetchImpl: () => {
        calls += 1;
        return upstream();
      },
    });
    await proxy.get("osm", 1, 1, 1);
    const file = path.join(dir, "osm", "1", "1", "1.png");
    const old = new Date(now - 30 * 24 * 60 * 60 * 1000);
    await utimes(file, old, old);

    // A tile server that never answers does not hold up the stale tile.
    upstream = () => new Promise<Response>(() => undefined);
    await expect(proxy.get("osm", 1, 1, 1)).resolves.toMatchObject({ body: PNG, cached: true });
    await vi.waitFor(() => {
      expect(calls).toBe(2);
    });

    const other = path.join(dir, "osm", "1", "0", "0.png");
    upstream = () => Promise.resolve(png());
    await proxy.get("osm", 1, 0, 0);
    await utimes(other, old, old);
    upstream = () => Promise.reject(new Error("unreachable"));
    await expect(proxy.get("osm", 1, 0, 0)).resolves.toMatchObject({ cached: true });
    await vi.waitFor(async () => {
      await proxy.get("osm", 1, 0, 0);
      expect(calls).toBe(4);
    });
    // The failed refresh pauses the layer: stale tiles are served without asking.
    await proxy.get("osm", 1, 0, 0);
    expect(calls).toBe(4);
    now += 11 * 60 * 1000;
    await proxy.get("osm", 1, 0, 0);
    await vi.waitFor(() => {
      expect(calls).toBe(5);
    });
  });

  it("stops reading an endless tile at the cap instead of buffering it (OP-004)", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const proxy = new TileProxy({
      cacheDir: dir,
      userAgent: () => "t",
      fetchImpl: () =>
        Promise.resolve(
          new Response(endless, { status: 200, headers: { "content-type": "image/png" } }),
        ),
    });
    await expect(proxy.get("osm", 1, 1, 1)).rejects.toMatchObject({ statusCode: 502 });
    // 1 MB cap in 64 kB chunks: cancelled right after the cap, never read on.
    expect(pulled).toBeLessThan(40);
  });

  it("never fetches a custom layer from an address inside the network (OP-003)", async () => {
    let called = false;
    const proxy = new TileProxy({
      cacheDir: dir,
      userAgent: () => "t",
      layers: () => [
        {
          id: "custom",
          label: "Internal",
          kind: "base",
          url: "https://192.168.0.10/{z}/{x}/{y}.png",
          format: "png",
          maxZoom: 19,
          attribution: "",
          satellite: false,
          cacheKey: "custom-internal",
        },
      ],
      fetchImpl: () => {
        called = true;
        return Promise.resolve(png());
      },
    });
    await expect(proxy.get("custom", 1, 1, 1)).rejects.toMatchObject({ statusCode: 502 });
    expect(called).toBe(false);
  });
});

describe("tile caching headers (OP-079)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "op-tiles-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads freshness from Cache-Control, then Expires, and falls back to a week", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    const meta = (headers: Record<string, string>) => cacheMeta(new Headers(headers), now);
    expect(meta({ "cache-control": "public, max-age=3600", etag: '"a"' })).toEqual({
      freshMs: 3_600_000,
      etag: '"a"',
    });
    expect(meta({ "cache-control": "max-age=60, s-maxage=120" }).freshMs).toBe(120_000);
    expect(meta({ "cache-control": "no-cache" }).freshMs).toBe(0);
    expect(
      meta({ date: "Wed, 25 Nov 2026 12:00:00 GMT", expires: "Thu, 26 Nov 2026 12:00:00 GMT" })
        .freshMs,
    ).toBe(86_400_000);
    expect(meta({}).freshMs).toBe(DEFAULT_FRESH_MS);
    expect(DEFAULT_FRESH_MS).toBeGreaterThanOrEqual(7 * 86_400_000);
  });

  it("refreshes a stale tile conditionally and keeps it on 304 Not Modified", async () => {
    let now = Date.now();
    const sent: Headers[] = [];
    let answer: () => Response = () =>
      new Response(PNG, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "cache-control": "max-age=60",
          etag: '"v1"',
          "last-modified": "Tue, 24 Nov 2026 10:00:00 GMT",
        },
      });
    const proxy = new TileProxy({
      cacheDir: dir,
      userAgent: () => "t",
      now: () => now,
      fetchImpl: (_input, init) => {
        sent.push(new Headers(init.headers));
        return Promise.resolve(answer());
      },
    });
    await proxy.get("osm", 1, 1, 1);
    expect(sent[0]?.get("if-none-match")).toBeNull();

    // Within max-age: no request at all.
    now += 30_000;
    await proxy.get("osm", 1, 1, 1);
    expect(sent).toHaveLength(1);

    // Past max-age: the stale copy is served and revalidated with its validators.
    now += 60_000;
    answer = () => new Response(null, { status: 304, headers: { "cache-control": "max-age=600" } });
    await expect(proxy.get("osm", 1, 1, 1)).resolves.toMatchObject({ body: PNG, cached: true });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(sent[1]?.get("if-none-match")).toBe('"v1"');
    expect(sent[1]?.get("if-modified-since")).toBe("Tue, 24 Nov 2026 10:00:00 GMT");
    await vi.waitFor(async () => {
      const info = await stat(path.join(dir, "osm", "1", "1", "1.png"));
      expect(Math.round(info.mtimeMs / 1000)).toBe(Math.round(now / 1000));
    });

    // The 304's own max-age now applies.
    now += 300_000;
    await proxy.get("osm", 1, 1, 1);
    expect(sent).toHaveLength(2);
  });
});

describe("tile layers", () => {
  it("validates custom templates", () => {
    expect(templateProblem("https://tiles.example.org/{z}/{x}/{y}.png?key={key}")).toBeNull();
    expect(templateProblem("https://{s}.example.org/{z}/{x}/{y}{r}.png")).toBeNull();
    expect(templateProblem("http://tiles.example.org/{z}/{x}/{y}.png")).toMatch(/https/);
    expect(templateProblem("https://tiles.example.org/{z}/{x}.png")).toMatch(/\{y\}/);
    expect(templateProblem("https://tiles.example.org/{z}/{x}/{y}/{bbox}")).toMatch(/bbox/);
    expect(templateProblem("https://u:p@tiles.example.org/{z}/{x}/{y}")).toMatch(/credentials/);
    expect(templateProblem("{z}{x}{y}")).toBe("Not a URL.");
    expect(templateProblem("https://192.168.0.10/{z}/{x}/{y}.png")).toMatch(/public/);
    expect(templateProblem("https://tiles.localhost/{z}/{x}/{y}.png")).toMatch(/public/);
  });

  it("fills the key in on the server and escapes the attribution", () => {
    const layer = customLayer({
      url: "https://{s}.example.org/{z}/{x}/{y}{r}.jpg?key={key}",
      apiKey: "se cret",
      attribution: "<b>Example</b>",
      maxZoom: 18,
    });
    expect(layer).not.toBeNull();
    if (layer === null) return;
    expect(layer.format).toBe("jpg");
    expect(layer.attribution).toBe("&lt;b&gt;Example&lt;/b&gt;");
    expect(tileUrl(layer, 3, 1, 2)).toBe("https://a.example.org/3/1/2.jpg?key=se%20cret");
  });

  it("leaves a keyed custom provider out until its key is set", () => {
    const url = "https://tiles.example.org/{z}/{x}/{y}.png?key={key}";
    expect(
      availableLayers({ url, apiKey: undefined, attribution: undefined, maxZoom: 19 }),
    ).toEqual(BUILTIN_LAYERS);
    expect(
      availableLayers({ url, apiKey: "k", attribution: undefined, maxZoom: 19 }).map((l) => l.id),
    ).toContain("custom");
  });

  it("offers the CARTO styles only with a CARTO key, which the server fills in", () => {
    expect(availableLayers(undefined).some((layer) => layer.id.startsWith("carto"))).toBe(false);
    const layers = availableLayers(undefined, "c key");
    const dark = layers.find((layer) => layer.id === "carto_dark");
    expect(layers.filter((layer) => layer.id.startsWith("carto")).map((l) => l.id)).toEqual([
      "carto_dark",
      "carto_light",
      "carto_voyager",
    ]);
    expect(dark === undefined ? null : tileUrl(dark, 5, 16, 10)).toBe(
      "https://basemaps.cartocdn.com/rastertiles/dark_all/5/16/10.png?key=c%20key",
    );
  });
  it("credits OpenStreetMap with a map issue link and names the served EOX imagery year", () => {
    const byId = new Map(BUILTIN_LAYERS.map((layer) => [layer.id, layer]));
    expect(byId.get("osm")?.attribution).toContain("https://www.openstreetmap.org/fixthemap");
    expect(byId.get("osm")?.attribution).toContain("OpenStreetMap</a> contributors");
    const satellite = byId.get("satellite");
    expect(satellite?.label).toMatch(/non-commercial use only/);
    expect(satellite?.url).toContain(`s2cloudless-${String(EOX_CLOUDLESS_YEAR)}_3857`);
    expect(satellite?.attribution).toContain(
      `Copernicus Sentinel data ${String(EOX_CLOUDLESS_YEAR)}`,
    );
    expect(satellite?.attribution).toContain("CC BY-NC-SA 4.0");
  });

  it("moves built-in layers to configured addresses, each into its own cache folder", () => {
    expect(builtinLayers()).toEqual(BUILTIN_LAYERS);
    const layers = builtinLayers({
      osm: "https://tiles.example.org/osm/{z}/{x}/{y}.png",
      eox: "https://wmts.example.org/1.0.0/",
    });
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    const osm = byId.get("osm");
    expect(osm === undefined ? null : tileUrl(osm, 1, 0, 1)).toBe(
      "https://tiles.example.org/osm/1/0/1.png",
    );
    expect(osm?.cacheKey).toMatch(/^osm-[0-9a-f]{12}$/);
    expect(byId.get("topo")).toEqual(BUILTIN_LAYERS.find((layer) => layer.id === "topo"));
    for (const id of ["satellite", "borders", "labels"]) {
      expect(byId.get(id)?.url.startsWith("https://wmts.example.org/1.0.0/")).toBe(true);
    }
    expect(
      availableLayers(undefined, undefined, { topo: "https://t.example.org/{z}/{x}/{y}.png" }).find(
        (layer) => layer.id === "topo",
      )?.url,
    ).toBe("https://t.example.org/{z}/{x}/{y}.png");
  });

  it("checks an EOX base address", () => {
    expect(wmtsBaseProblem("https://wmts.example.org/1.0.0")).toBeNull();
    expect(wmtsBaseProblem("https://wmts.example.org/{z}")).toMatch(/placeholders/);
    expect(wmtsBaseProblem("http://wmts.example.org")).toMatch(/https/);
  });
});
