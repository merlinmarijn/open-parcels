import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  availableLayers,
  BUILTIN_LAYERS,
  customLayer,
  templateProblem,
  tileUrl,
} from "../../src/tiles/layers.js";
import { TileError, TileProxy, validTile } from "../../src/tiles/proxy.js";

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
      userAgent: "open-parcels/test",
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
      userAgent: "t",
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
      "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/GoogleMapsCompatible/2/3/1.jpg",
    );
    await stat(path.join(dir, "osm", "2", "1", "3.png"));
    await stat(path.join(dir, "s2cloudless-2025", "2", "1", "3.jpg"));
    await proxy.get("satellite", 2, 1, 3);
    expect(urls).toHaveLength(2);
  });

  it("refuses unknown layers and bad coordinates without any request", async () => {
    let called = false;
    const proxy = new TileProxy({
      cacheDir: dir,
      userAgent: "t",
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
      userAgent: "t",
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
      userAgent: "t",
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
      userAgent: "t",
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
      userAgent: "t",
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
});
