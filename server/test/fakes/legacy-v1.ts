import SQLite from "better-sqlite3";

/**
 * The schema of a deployed v1 database (`legacy-ts`, UUID variant), statement for statement as the
 * v1 migrations left it, including the late `is_manual_status` column and the unused audit log.
 */
export const LEGACY_V1_DDL = `
CREATE TABLE \`audit_logs\` (\`id\` text PRIMARY KEY NOT NULL, \`action\` text NOT NULL, \`actor\` text NOT NULL, \`details\` text, \`timestamp\` integer NOT NULL);
CREATE TABLE \`credentials\` (\`id\` text PRIMARY KEY NOT NULL, \`service\` text NOT NULL, \`encrypted_data\` text NOT NULL, \`updated_at\` integer NOT NULL);
CREATE TABLE \`orders\` (\`id\` text PRIMARY KEY NOT NULL, \`source\` text NOT NULL, \`order_number\` text NOT NULL, \`status\` text NOT NULL, \`placed_at\` integer, \`added_at\` integer NOT NULL, \`updated_at\` integer NOT NULL);
CREATE TABLE \`parcel_events\` (\`id\` text PRIMARY KEY NOT NULL, \`parcel_id\` text NOT NULL, \`location\` text, \`description\` text NOT NULL, \`timestamp\` integer NOT NULL, \`lat\` real, \`lng\` real, \`vehicle\` text, \`source\` text, FOREIGN KEY (\`parcel_id\`) REFERENCES \`parcels\`(\`id\`) ON UPDATE no action ON DELETE no action);
CREATE TABLE \`parcels\` (\`id\` text PRIMARY KEY NOT NULL, \`tracking_number\` text NOT NULL, \`name\` text, \`courier\` text, \`status\` text NOT NULL, \`estimated_delivery_start\` integer, \`estimated_delivery_end\` integer, \`lat\` real, \`lng\` real, \`order_id\` text, \`last_vehicle\` text, \`last_event_description\` text, \`added_at\` integer NOT NULL, \`updated_at\` integer NOT NULL, \`is_manual_status\` integer DEFAULT 0, FOREIGN KEY (\`order_id\`) REFERENCES \`orders\`(\`id\`) ON UPDATE no action ON DELETE set null);
CREATE TABLE \`settings\` (\`key\` text PRIMARY KEY NOT NULL, \`value\` text NOT NULL, \`updated_at\` integer NOT NULL);
CREATE UNIQUE INDEX \`parcels_tracking_number_unique\` ON \`parcels\` (\`tracking_number\`);
`;

const T = 1_763_000_000; // seconds, as v1 stored them

/**
 * A made-up v1 database with the shapes a real one has: orders with and without parcels, parcels
 * with and without an order, generic couriers ("Unknown", "China", "17track"), statuses the v1
 * importer maps, events (one a live courier position), credentials and settings.
 */
export function writeLegacyV1Database(file: string): void {
  const legacy = new SQLite(file);
  legacy.exec(LEGACY_V1_DDL);
  const order = legacy.prepare("insert into orders values (?, ?, ?, ?, ?, ?, ?)");
  order.run("o-1", "Amazon", "000-0000000-0000001", "shipped", T, T, T);
  order.run("o-2", "aliexpress", "0000000000000001", "delivered", T, T, T);
  order.run("o-3", "Amazon", "000-0000000-0000002", "ordered", T, T, T);
  const parcel = legacy.prepare(
    "insert into parcels (id, tracking_number, name, courier, status, order_id, last_event_description, added_at, updated_at, is_manual_status) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  parcel.run("p-1", "00340434000000000001", null, "DHL", "sent", "o-1", "On its way", T, T, 0);
  parcel.run(
    "p-2",
    "LP00000000000001",
    null,
    "Aliexpress Standard Shipping",
    "delivered",
    "o-2",
    null,
    T,
    T,
    0,
  );
  parcel.run("p-3", "0000000001", null, "Unknown", "ordered", null, null, T, T, 0);
  parcel.run("p-4", "RR000000001CN", null, "China", "arriving", null, null, T, T, 1);
  parcel.run("p-5", "000000000001", "example-shop.de", "17track", "delivered", null, null, T, T, 0);
  const event = legacy.prepare(
    "insert into parcel_events (id, parcel_id, location, description, timestamp, source) values (?, ?, ?, ?, ?, ?)",
  );
  event.run("e-1", "p-1", "Hamburg", "Handed to courier", T, "dhl");
  event.run("e-2", "p-1", null, "Courier nearby", T + 60, "live");
  event.run("e-3", "p-2", null, "Delivered", T + 3600, "aliexpress");
  legacy.prepare("insert into credentials values (?, ?, ?, ?)").run("c-1", "Amazon", "00:00:00", T);
  legacy.prepare("insert into settings values (?, ?, ?)").run("timezone", "Europe/Berlin", T);
  legacy.close();
}
