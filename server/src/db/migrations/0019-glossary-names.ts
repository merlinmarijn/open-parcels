import { sql, type Kysely } from "kysely";

const OLD_DIRECTION_CHECK = "direction in ('incoming', 'outgoing')";
const NEW_DIRECTION_CHECK = "direction in ('receiving', 'sending')";

/** Tables and columns renamed to the glossary's terms (`docs/glossary.md`). */
const TABLE_RENAMES = [
  ["sources", "connections"],
  ["parcel_sources", "parcel_connections"],
  ["order_sources", "order_connections"],
  ["return_sources", "return_connections"],
] as const;

const COLUMN_RENAMES = [
  ["connections", "plugin", "provider"],
  ["parcel_connections", "source_id", "connection_id"],
  ["order_connections", "source_id", "connection_id"],
  ["return_connections", "source_id", "connection_id"],
  ["parcel_events", "source_id", "connection_id"],
  ["parcel_raw", "source_id", "connection_id"],
  ["sign_in_attempts", "source_id", "connection_id"],
  ["unknown_vocab", "plugin", "provider"],
  ["parcels", "barcode", "tracking_number"],
  ["parcels", "planned_from", "expected_from"],
  ["parcels", "planned_to", "expected_to"],
] as const;

/** Indexes named after old terms: dropped and created again under the new names. */
const INDEX_RENAMES = [
  ["parcel_sources_source", "parcel_connections_connection", "parcel_connections"],
  ["order_sources_source", "order_connections_connection", "order_connections"],
  ["return_sources_source", "return_connections_connection", "return_connections"],
  ["parcel_events_source", "parcel_events_connection", "parcel_events"],
  ["sign_in_attempts_source", "sign_in_attempts_connection", "sign_in_attempts"],
] as const;

/**
 * Brings table, column, index and stored event names to the glossary (`docs/glossary.md`):
 * a source is a connection, a plug-in a provider, a barcode a tracking number, the planned window
 * the expected delivery, and a parcel's direction is `receiving` or `sending` instead of
 * `incoming` or `outgoing`.
 *
 * The outbox is emptied: its live events use the old names (see `renameEverything`).
 *
 * SQLite renames keep every foreign key pointing at the renamed table. The direction CHECK
 * constraint cannot be altered, so `parcels` is rebuilt from its stored definition (keeping every
 * column earlier migrations added) with foreign keys off, as 0009 did for `sources`, and its
 * indexes are created again. Everything runs in one transaction.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`pragma foreign_keys = off`.execute(db);
  try {
    await sql`begin`.execute(db);
    try {
      await renameEverything(db);
      await rebuildParcels(db);
      const broken = await sql`pragma foreign_key_check`.execute(db);
      if (broken.rows.length > 0) {
        throw new Error("renaming to the glossary terms left dangling foreign keys");
      }
      await sql`commit`.execute(db);
    } catch (error) {
      await sql`rollback`.execute(db);
      throw error;
    }
  } finally {
    await sql`pragma foreign_keys = on`.execute(db);
  }
}

async function renameEverything(db: Kysely<unknown>): Promise<void> {
  for (const [from, to] of TABLE_RENAMES) {
    await sql`alter table ${sql.table(from)} rename to ${sql.table(to)}`.execute(db);
  }
  for (const [table, from, to] of COLUMN_RENAMES) {
    await sql`alter table ${sql.table(table)} rename column ${sql.ref(from)} to ${sql.ref(to)}`.execute(
      db,
    );
  }
  for (const [from, to, table] of INDEX_RENAMES) {
    await sql`drop index if exists ${sql.table(from)}`.execute(db);
    await sql`create index ${sql.table(to)} on ${sql.table(table)} (connection_id)`.execute(db);
  }
  // Stored live events carry the old names in their types and payloads. They are kept only for
  // replays; clients that ask for one after this get `resync` and reload over REST instead.
  await sql`delete from outbox`.execute(db);
}

async function rebuildParcels(db: Kysely<unknown>): Promise<void> {
  const stored = await sql<{ sql: string }>`
    select sql from sqlite_master where type = 'table' and name = 'parcels'
  `.execute(db);
  const definition = stored.rows[0]?.sql;
  if (definition?.includes(OLD_DIRECTION_CHECK) !== true) {
    throw new Error("parcels table does not have the expected direction constraint");
  }
  const rebuilt = definition
    .replace(OLD_DIRECTION_CHECK, NEW_DIRECTION_CHECK)
    .replace('"parcels_carrier_barcode"', '"parcels_carrier_tracking_number"')
    .replace(/^create table "?parcels"?/i, 'create table "parcels_rebuild"');
  const columns = await sql<{ name: string }>`
    select name from pragma_table_info('parcels') order by cid
  `.execute(db);
  const names = columns.rows.map((row) => row.name);
  const selected = names.map((name) =>
    name === "direction"
      ? sql`case direction when 'incoming' then 'receiving' when 'outgoing' then 'sending' else direction end`
      : sql.ref(name),
  );

  await sql.raw(rebuilt).execute(db);
  await sql`
    insert into parcels_rebuild (${sql.join(names.map((name) => sql.ref(name)))})
    select ${sql.join(selected)} from parcels
  `.execute(db);
  await sql`drop table parcels`.execute(db);
  await sql`alter table parcels_rebuild rename to parcels`.execute(db);
  await sql`create index parcels_active on parcels (delivered, archived_at)`.execute(db);
  await sql`create index parcels_order on parcels (order_id)`.execute(db);
  await sql`create index parcels_tracking_number on parcels (tracking_number)`.execute(db);
}
