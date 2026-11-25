/**
 * Fills a database with made-up data at history-import scale, for measuring (docs/performance.md).
 *
 * Usage, from `server/` after `npm run build`, with the server's OPENPARCELS_* environment:
 *   node dist/tools/seed-scale.js [--parcels 10000] [--orders 5000]
 * Refuses a database that already holds parcels. Prints a read-scoped API token for the
 * measurements. Never run it against a real installation: everything it writes is invented.
 */
import { parseArgs } from "node:util";
import type SQLite from "better-sqlite3";
import { AuthStore } from "../auth/store.js";
import { systemClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { migrateToLatest, openDatabase } from "../db/database.js";
import { runTool, type ToolMain } from "./cli.js";

export interface ScaleOptions {
  readonly parcels: number;
  readonly orders: number;
  /** The newest timestamp; the data reaches about four years back from it. */
  readonly now: Date;
}

export interface ScaleCounts {
  readonly parcels: number;
  readonly orders: number;
  readonly events: number;
  readonly items: number;
  readonly orderItems: number;
  readonly returns: number;
}

const DAY = 86_400_000;
const SHOPS = ["amazon", "aliexpress", "ebay", "reichelt", "example_shop"] as const;
const CARRIERS = ["dhl", "hermes", "dpd", "gls", "ups", "cainiao", "amazon"] as const;
const PLACES = [
  ["Hamburg", 53.55, 9.99],
  ["Leipzig", 51.34, 12.37],
  ["Köln", 50.94, 6.96],
  ["Shenzhen", 22.54, 114.06],
] as const;
const ACTIVE_STATUSES = ["registered", "in_transit", "out_for_delivery", "at_pickup_point"];

/** A small deterministic generator (mulberry32): the same options give the same database. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(next: () => number, list: readonly T[]): T {
  return list[Math.floor(next() * list.length)] as T;
}

const iso = (ms: number): string => new Date(ms).toISOString();

interface Writers {
  readonly connection: SQLite.Statement;
  readonly order: SQLite.Statement;
  readonly orderConnection: SQLite.Statement;
  readonly orderItem: SQLite.Statement;
  readonly parcel: SQLite.Statement;
  readonly parcelConnection: SQLite.Statement;
  readonly event: SQLite.Statement;
  readonly item: SQLite.Statement;
  readonly returnRow: SQLite.Statement;
  readonly returnItem: SQLite.Statement;
}

function writers(sqlite: SQLite.Database): Writers {
  return {
    connection: sqlite.prepare(
      "insert into connections (id, provider, kind, label, config, state, created_at, updated_at) values (?, ?, ?, ?, '{}', ?, ?, ?)",
    ),
    order: sqlite.prepare(
      "insert into orders (id, shop, order_number, placed_at, status, created_at, updated_at, archived_at, total_amount, total_currency) values (?, ?, ?, ?, null, ?, ?, ?, ?, 'EUR')",
    ),
    orderConnection: sqlite.prepare(
      "insert into order_connections (order_id, connection_id) values (?, ?)",
    ),
    orderItem: sqlite.prepare(
      "insert into order_items (order_id, position, title, image_ref, quantity, price, currency, parcel_id) values (?, ?, ?, ?, 1, ?, 'EUR', ?)",
    ),
    parcel: sqlite.prepare(
      "insert into parcels (id, carrier, tracking_number, direction, status, raw_status, delivered, delivered_at, expected_from, expected_to, pickup, label, order_id, first_seen_at, last_seen_at, updated_at, archived_at, status_at, lookup_state) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'found')",
    ),
    parcelConnection: sqlite.prepare(
      "insert into parcel_connections (parcel_id, connection_id, role, last_seen_at) values (?, ?, 'primary', ?)",
    ),
    event: sqlite.prepare(
      "insert into parcel_events (parcel_id, connection_id, at, status, raw_status, location_text, latitude, longitude, fingerprint) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    item: sqlite.prepare(
      "insert into items (parcel_id, position, title, image_ref, quantity, price, currency) values (?, ?, ?, ?, 1, ?, 'EUR')",
    ),
    returnRow: sqlite.prepare(
      "insert into returns (id, order_id, status, return_by, drop_off, created_at, updated_at) values (?, ?, ?, ?, '[]', ?, ?)",
    ),
    returnItem: sqlite.prepare(
      "insert into return_items (return_id, position, title) values (?, ?, ?)",
    ),
  };
}

interface Seeded {
  readonly orderIds: readonly string[];
  readonly orderShops: readonly string[];
  readonly connections: Readonly<Record<string, string>>;
}

function seedConnections(w: Writers, now: string): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [key, provider, kind] of [
    ["shop", "amazon", "shop"],
    ["shop2", "aliexpress", "shop"],
    ["dhl", "dhl", "tracking"],
    ["hermes", "hermes", "tracking"],
    ["mail", "mail", "mail"],
  ] as const) {
    ids[key] = crypto.randomUUID();
    w.connection.run(ids[key], provider, kind, `Scale ${key}`, "ok", now, now);
  }
  return ids;
}

function seedOrders(w: Writers, next: () => number, options: ScaleOptions, now: number): Seeded {
  const connections = seedConnections(w, iso(now));
  const orderIds: string[] = [];
  const orderShops: string[] = [];
  for (let n = 0; n < options.orders; n += 1) {
    const id = crypto.randomUUID();
    const shop = pick(next, SHOPS);
    const placed = now - Math.floor(next() * 4 * 365 * DAY);
    const archived = now - placed > 60 * DAY ? iso(placed + 40 * DAY) : null;
    w.order.run(
      id,
      shop,
      `SCALE-${String(n).padStart(8, "0")}`,
      iso(placed),
      iso(placed),
      iso(placed + 5 * DAY),
      archived,
      Math.round(next() * 20_000) / 100,
    );
    w.orderConnection.run(id, shop === "aliexpress" ? connections["shop2"] : connections["shop"]);
    orderIds.push(id);
    orderShops.push(shop);
  }
  return { orderIds, orderShops, connections };
}

/** Writes connections, orders, parcels with history and items, and returns, in one transaction. */
export function seedScale(sqlite: SQLite.Database, options: ScaleOptions): ScaleCounts {
  const next = random(42);
  const now = options.now.getTime();
  const w = writers(sqlite);
  const counts = {
    parcels: 0,
    orders: options.orders,
    events: 0,
    items: 0,
    orderItems: 0,
    returns: 0,
  };
  sqlite.transaction(() => {
    const { orderIds, connections } = seedOrders(w, next, options, now);
    const trackingConnections = [connections["dhl"], connections["hermes"], connections["mail"]];
    const orderParcels = new Map<string, string[]>();
    for (let n = 0; n < options.parcels; n += 1) {
      const id = crypto.randomUUID();
      // Three in four parcels belong to an order; an order gets one to three of them.
      const orderId = next() < 0.75 && orderIds.length > 0 ? pick(next, orderIds) : null;
      const first = now - Math.floor(next() * 4 * 365 * DAY);
      const age = now - first;
      const delivered = age > 10 * DAY || next() < 0.3;
      const status = delivered ? "delivered" : pick(next, ACTIVE_STATUSES);
      const last = Math.min(now, first + Math.floor((2 + next() * 6) * DAY));
      const archived = delivered && age > 30 * DAY ? iso(last + 14 * DAY) : null;
      const expected = delivered ? null : iso(now + Math.floor(next() * 5) * DAY);
      w.parcel.run(
        id,
        pick(next, CARRIERS),
        `SC${String(n).padStart(12, "0")}`,
        next() < 0.05 ? "sending" : "receiving",
        status,
        delivered ? "Delivered" : "On its way",
        delivered ? 1 : 0,
        delivered ? iso(last) : null,
        expected,
        expected,
        next() < 0.3 ? `Scale parcel ${String(n)}` : null,
        orderId,
        iso(first),
        iso(last),
        iso(last),
        archived,
        iso(last),
      );
      const connection = pick(next, trackingConnections) ?? null;
      w.parcelConnection.run(id, connection, iso(last));
      const events = 4 + Math.floor(next() * 9);
      for (let e = 0; e < events; e += 1) {
        const place = pick(next, PLACES);
        const located = next() < 0.4;
        w.event.run(
          id,
          connection,
          iso(first + ((last - first) * e) / events),
          e === events - 1 ? status : "in_transit",
          `Scale event ${String(e)}`,
          place[0],
          located ? place[1] : null,
          located ? place[2] : null,
          `scale-${String(e)}`,
        );
      }
      counts.events += events;
      const items = 1 + Math.floor(next() * 2);
      for (let i = 0; i < items; i += 1) {
        w.item.run(
          id,
          i,
          `Scale item ${String(n)}.${String(i)}`,
          `https://images.example.invalid/${String(n)}-${String(i)}.jpg`,
          Math.round(next() * 5000) / 100,
        );
      }
      counts.items += items;
      if (orderId !== null) orderParcels.set(orderId, [...(orderParcels.get(orderId) ?? []), id]);
      counts.parcels += 1;
    }
    for (const [o, orderId] of orderIds.entries()) {
      const parcels = orderParcels.get(orderId) ?? [];
      const lines = 1 + Math.floor(next() * 4);
      for (let i = 0; i < lines; i += 1) {
        w.orderItem.run(
          orderId,
          i,
          `Scale line ${String(o)}.${String(i)}`,
          `https://images.example.invalid/o${String(o)}-${String(i)}.jpg`,
          Math.round(next() * 5000) / 100,
          parcels[i % Math.max(parcels.length, 1)] ?? null,
        );
      }
      counts.orderItems += lines;
      // One order in twenty-five has a return.
      if (o % 25 === 0) {
        const returnId = crypto.randomUUID();
        const created = now - Math.floor(next() * 365 * DAY);
        w.returnRow.run(
          returnId,
          orderId,
          pick(next, ["requested", "returning", "returned", "refunded"]),
          iso(created + 14 * DAY).slice(0, 10),
          iso(created),
          iso(created),
        );
        w.returnItem.run(returnId, 0, `Scale line ${String(o)}.0`);
        counts.returns += 1;
      }
    }
  })();
  sqlite.pragma("optimize");
  return counts;
}

export const main: ToolMain = async (argv, output) => {
  const { values } = parseArgs({
    args: [...argv],
    options: { parcels: { type: "string" }, orders: { type: "string" } },
    strict: true,
  });
  const config = loadConfig();
  const { db, sqlite } = openDatabase(config.databasePath);
  try {
    await migrateToLatest(db);
    const existing = sqlite.prepare("select count(*) as n from parcels").get() as { n: number };
    if (existing.n > 0) {
      throw new Error("This database already holds parcels; seed an empty one.");
    }
    const counts = seedScale(sqlite, {
      parcels: Number(values.parcels ?? 10_000),
      orders: Number(values.orders ?? 5_000),
      now: new Date(),
    });
    const { token } = await new AuthStore(db, systemClock).createToken("scale", ["read"], null);
    output.out(`${JSON.stringify({ ...counts, token }, null, 2)}\n`);
  } finally {
    await db.destroy();
  }
};

if (import.meta.main) {
  runTool("Seeding failed", main);
}
