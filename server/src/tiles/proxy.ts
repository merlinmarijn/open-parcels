import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { readCapped } from "../images/proxy.js";
import { isNonPublicHostLiteral } from "../net/address.js";
import { guardedFetch } from "../net/guarded-fetch.js";
import { BUILTIN_LAYERS, tileUrl, type TileLayerDef } from "./layers.js";

/**
 * Map tiles fetched through this server, following OpenStreetMap's tile usage policy (applied to
 * every provider): an identifying User-Agent, at most two upstream connections, only tiles a map
 * on screen asks for (nothing is prefetched or bulk-downloaded), and a disk cache kept as long as
 * the tile server's Cache-Control or Expires allows, a week when it says nothing. A stale tile is
 * refreshed with a conditional request (If-None-Match / If-Modified-Since). Browsers that strip the Referer (LibreWolf, privacy add-ons) are refused by
 * the tile servers when they ask directly, and the providers never see the user's browser, so the
 * web UI always goes through here. Each layer has its own cache folder.
 */
export const TILE_MAX_ZOOM = 19;
/** No provider serves deeper than this; the route refuses anything beyond it up front. */
export const TILE_MAX_ZOOM_ANY = 22;
/** How long a tile counts as fresh when its server sent no caching headers (policy minimum). */
export const DEFAULT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_UPSTREAM = 2;
const MAX_TILE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
/** After a failed refresh of a stale tile, the layer's stale tiles are served without asking. */
const REFRESH_BACKOFF_MS = 10 * 60 * 1000;

export class TileError extends Error {
  override readonly name = "TileError";
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Tile {
  readonly body: Buffer;
  readonly cached: boolean;
  readonly contentType: string;
}

export interface TileProxyOptions {
  readonly cacheDir: string;
  /** Read per request, so a contact address saved in the UI applies at once. */
  readonly userAgent: () => string;
  /** The layers that may be fetched, read on every request so setting changes apply at once. */
  readonly layers?: () => readonly TileLayerDef[];
  /** Unset: the guarded transport, which refuses non-public addresses at connect time. */
  readonly fetchImpl?: (input: URL, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  /** Tiles not refreshed for this long are deleted by `prune()`. */
  readonly maxAgeMs?: number;
  readonly maxCacheBytes?: number;
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_BYTES = 200 * 1024 * 1024;
const CONTENT_TYPES = { png: "image/png", jpg: "image/jpeg" } as const;

/** Valid slippy-map coordinates only; anything else never reaches the network or the disk. */
export function validTile(z: number, x: number, y: number, maxZoom = TILE_MAX_ZOOM): boolean {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > maxZoom) {
    return false;
  }
  const size = 2 ** z;
  return x >= 0 && y >= 0 && x < size && y < size;
}

export class TileProxy {
  readonly #options: TileProxyOptions;
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  readonly #inflight = new Map<string, Promise<Tile>>();
  readonly #refreshing = new Set<string>();
  /** Per layer cache key: no stale tile is refreshed before this time. */
  readonly #refreshAfter = new Map<string, number>();

  constructor(options: TileProxyOptions) {
    this.#options = options;
  }

  /** The allowlist: the built-in layers plus a configured custom provider. */
  layers(): readonly TileLayerDef[] {
    return this.#options.layers?.() ?? BUILTIN_LAYERS;
  }

  /** Unknown layers are refused before anything is fetched or read. */
  async get(layerId: string, z: number, x: number, y: number): Promise<Tile> {
    const layer = this.layers().find((candidate) => candidate.id === layerId);
    if (layer === undefined) {
      throw new TileError(404, "There is no such map layer.");
    }
    if (!validTile(z, x, y, layer.maxZoom)) {
      throw new TileError(400, "Not a map tile.");
    }
    const key = `${layer.cacheKey}/${String(z)}/${String(x)}/${String(y)}`;
    const pending = this.#inflight.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const work = this.#load(layer, z, x, y).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, work);
    return work;
  }

  async #load(layer: TileLayerDef, z: number, x: number, y: number): Promise<Tile> {
    const contentType = CONTENT_TYPES[layer.format];
    const file = path.join(
      this.#options.cacheDir,
      layer.cacheKey,
      String(z),
      String(x),
      `${String(y)}.${layer.format}`,
    );
    const now = this.#options.now?.() ?? Date.now();
    const cached = await readCached(file);
    if (cached === null) {
      const fetched = await this.#fetchUpstream(layer, [z, x, y], null, now);
      if (fetched.body === null) {
        throw new TileError(502, "The tile server answered a request it was not asked.");
      }
      await storeTile(file, fetched.body, fetched.meta);
      return { body: fetched.body, cached: false, contentType };
    }
    const freshUntil = cached.mtimeMs + (cached.meta?.freshMs ?? DEFAULT_FRESH_MS);
    if (now >= freshUntil) {
      // A stale tile is served at once and refreshed behind it, so a tile server that is down
      // never makes the map wait for its time-out.
      this.#refresh(layer, file, [z, x, y], cached.meta, now);
    }
    return { body: cached.body, cached: true, contentType };
  }

  #refresh(
    layer: TileLayerDef,
    file: string,
    tile: readonly [number, number, number],
    validators: TileMeta | null,
    now: number,
  ): void {
    if (this.#refreshing.has(file) || now < (this.#refreshAfter.get(layer.cacheKey) ?? 0)) {
      return;
    }
    this.#refreshing.add(file);
    void this.#fetchUpstream(layer, tile, validators, now)
      .then((fetched) =>
        fetched.body === null
          ? keepTile(file, fetched.meta, now)
          : storeTile(file, fetched.body, fetched.meta),
      )
      .catch(() => {
        // The stale copy stays in use; the layer is not asked again for a while.
        this.#refreshAfter.set(layer.cacheKey, now + REFRESH_BACKOFF_MS);
      })
      .finally(() => this.#refreshing.delete(file));
  }

  /** A null body: the server confirmed the cached copy (304) for the given validators. */
  async #fetchUpstream(
    layer: TileLayerDef,
    [z, x, y]: readonly [number, number, number],
    validators: TileMeta | null,
    now: number,
  ): Promise<{ body: Buffer | null; meta: TileMeta }> {
    await this.#acquire();
    try {
      const url = new URL(tileUrl(layer, z, x, y));
      // A custom provider may name any host: never one inside the network (see also the guarded
      // connection pool, which checks what a name resolves to).
      if (isNonPublicHostLiteral(url.hostname)) {
        throw new TileError(502, "The tile server is not a public address.");
      }
      const headers: Record<string, string> = {
        "user-agent": this.#options.userAgent(),
        accept: "image/*",
      };
      if (validators?.etag !== undefined) headers["if-none-match"] = validators.etag;
      if (validators?.lastModified !== undefined) {
        headers["if-modified-since"] = validators.lastModified;
      }
      const response = await (this.#options.fetchImpl ?? guardedFetch)(url, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "manual",
      });
      if (response.status === 304 && validators !== null) {
        await response.body?.cancel();
        return { body: null, meta: { ...validators, ...cacheMeta(response.headers, now) } };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new TileError(502, `The tile server answered HTTP ${String(response.status)}.`);
      }
      if (!(response.headers.get("content-type") ?? "").startsWith("image/")) {
        await response.body?.cancel();
        throw new TileError(502, "The tile server did not send an image.");
      }
      const implausible = () => new TileError(502, "The tile server sent an implausible tile.");
      const body = await readCapped(response, MAX_TILE_BYTES, implausible);
      if (body.length === 0) {
        throw implausible();
      }
      return { body, meta: cacheMeta(response.headers, now) };
    } catch (error) {
      if (error instanceof TileError) {
        throw error;
      }
      throw new TileError(504, "The tile server could not be reached.");
    } finally {
      this.#release();
    }
  }

  /**
   * Deletes tiles older than the age limit, then the oldest until the cache fits its budget.
   * Returns how many were removed. Empty folders are left; they cost nothing.
   */
  async prune(): Promise<number> {
    const now = this.#options.now?.() ?? Date.now();
    const maxAge = this.#options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const budget = this.#options.maxCacheBytes ?? DEFAULT_CACHE_BYTES;
    const files = await listTiles(this.#options.cacheDir);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    let removed = 0;
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (now - file.mtimeMs <= maxAge && total <= budget) {
        break;
      }
      await rm(file.path, { force: true });
      await rm(metaFile(file.path), { force: true });
      total -= file.size;
      removed += 1;
    }
    return removed;
  }

  async #acquire(): Promise<void> {
    if (this.#active < MAX_UPSTREAM) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#active -= 1;
    } else {
      next();
    }
  }
}

/**
 * What the tile server said about caching a tile: how long after it was stored (the file time)
 * it stays fresh, and its validators for the conditional refresh.
 */
export interface TileMeta {
  readonly freshMs: number;
  readonly etag?: string;
  readonly lastModified?: string;
}

/**
 * Freshness from Cache-Control (s-maxage, then max-age; no-cache and no-store mean stale at once)
 * or Expires; the policy's week when the server says nothing usable.
 */
export function cacheMeta(headers: Headers, now: number): TileMeta {
  const etag = headers.get("etag") ?? undefined;
  const lastModified = headers.get("last-modified") ?? undefined;
  const validators = {
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
  return { freshMs: freshnessMs(headers, now), ...validators };
}

function freshnessMs(headers: Headers, now: number): number {
  const directives = new Map(
    (headers.get("cache-control") ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase().split("=", 2))
      .filter((pair) => pair[0] !== undefined && pair[0] !== "")
      .map(([name, value]) => [name ?? "", (value ?? "").replace(/"/g, "")]),
  );
  if (directives.has("no-store") || directives.has("no-cache")) return 0;
  for (const name of ["s-maxage", "max-age"]) {
    const value = directives.get(name);
    if (value !== undefined && /^\d+$/.test(value)) return Number(value) * 1000;
  }
  const expires = Date.parse(headers.get("expires") ?? "");
  if (!Number.isNaN(expires)) {
    const date = Date.parse(headers.get("date") ?? "");
    return Math.max(0, expires - (Number.isNaN(date) ? now : date));
  }
  return DEFAULT_FRESH_MS;
}

function metaFile(file: string): string {
  return `${file}.meta.json`;
}

async function storeTile(file: string, body: Buffer, meta: TileMeta): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temporary, body);
  await rename(temporary, file);
  await writeMeta(file, meta);
}

/** A 304: the copy stays, with the new freshness, and counts as recently used for pruning. */
async function keepTile(file: string, meta: TileMeta, now: number): Promise<void> {
  await writeMeta(file, meta);
  const at = new Date(now);
  await utimes(file, at, at);
}

async function writeMeta(file: string, meta: TileMeta): Promise<void> {
  const temporary = `${metaFile(file)}.${String(process.pid)}.tmp`;
  await writeFile(temporary, JSON.stringify(meta));
  await rename(temporary, metaFile(file));
}

async function readMeta(file: string): Promise<TileMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(metaFile(file), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { freshMs, etag, lastModified } = parsed as Record<string, unknown>;
    if (typeof freshMs !== "number") return null;
    return {
      freshMs,
      ...(typeof etag === "string" ? { etag } : {}),
      ...(typeof lastModified === "string" ? { lastModified } : {}),
    };
  } catch {
    // A tile cached without its headers (or with a damaged record) ages by its file time.
    return null;
  }
}

async function listTiles(root: string): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch {
    return [];
  }
  const tiles = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".png") || entry.endsWith(".jpg"))
      .map(async (entry) => {
        const file = path.join(root, entry);
        const info = await stat(file);
        return { path: file, size: info.size, mtimeMs: info.mtimeMs };
      }),
  );
  return tiles;
}

async function readCached(
  file: string,
): Promise<{ body: Buffer; mtimeMs: number; meta: TileMeta | null } | null> {
  try {
    const info = await stat(file);
    return { body: await readFile(file), mtimeMs: info.mtimeMs, meta: await readMeta(file) };
  } catch {
    return null;
  }
}
