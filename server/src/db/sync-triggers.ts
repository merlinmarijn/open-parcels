import { sql, type Kysely } from "kysely";

/**
 * Delta sync bookkeeping (`GET /api/v1/sync`, docs/sync.md). Every insert, change and delete of a
 * synced row, and of the rows embedded in it (a parcel's items, connections and courier; an
 * order's lines and connections; a return's items and connections), writes one row to
 * `sync_changes` in the same statement, through these triggers, so no writer can forget it and a
 * rolled-back transaction leaves nothing behind. Each entity keeps only its newest row, moved to a
 * new `seq`, so the table holds one row per entity plus the tombstones of deleted ones.
 *
 * Columns that change on every provider run without the client seeing a difference (when a parcel
 * or its link was last seen, when the carrier was last asked) do not count as a change. Change
 * detection lists the columns at migration time: a migration that adds a column to a synced table
 * calls `createSyncTriggers` again.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Synced table → entity name and its id expression. */
const ENTITIES = {
  parcels: { entity: "parcel", id: "id" },
  parcel_events: { entity: "event", id: "cast(id as text)" },
  orders: { entity: "order", id: "id" },
  returns: { entity: "return", id: "id" },
  connections: { entity: "connection", id: "id" },
} as const;

/** Columns whose changes are not a change for clients. */
const IGNORED: Readonly<Record<string, readonly string[]>> = {
  parcels: ["last_seen_at", "lookup_checked_at"],
  parcel_events: ["updated_at"],
  parcel_connections: ["last_seen_at"],
};

/** Embedded rows → the entity they belong to, by the column that names it. */
const EMBEDDED: readonly { table: string; entity: string; key: string }[] = [
  { table: "items", entity: "parcel", key: "parcel_id" },
  { table: "parcel_connections", entity: "parcel", key: "parcel_id" },
  { table: "live_state", entity: "parcel", key: "parcel_id" },
  { table: "order_items", entity: "order", key: "order_id" },
  { table: "order_connections", entity: "order", key: "order_id" },
  { table: "return_items", entity: "return", key: "return_id" },
  { table: "return_connections", entity: "return", key: "return_id" },
  // An order's status follows its parcels.
  { table: "parcels", entity: "order", key: "order_id" },
];

/** Marks the entities whose ids `select` returns (one column, `id`) as changed or deleted. */
function mark(entity: string, select: string, deleted: 0 | 1): string {
  return `
    delete from sync_changes where entity = '${entity}' and entity_id in (${select});
    insert into sync_changes (entity, entity_id, deleted, changed_at)
      select distinct '${entity}', id, ${String(deleted)}, ${NOW} from (${select}) where id is not null;`;
}

async function columns(db: Kysely<unknown>, table: string): Promise<string[]> {
  const rows = await sql<{ name: string }>`select name from pragma_table_info(${table})`.execute(
    db,
  );
  return rows.rows.map((row) => row.name).filter((name) => !(IGNORED[table] ?? []).includes(name));
}

function changed(cols: readonly string[]): string {
  return cols.map((col) => `old.${col} is not new.${col}`).join(" or ");
}

function rowId(table: keyof typeof ENTITIES, row: "new" | "old"): string {
  return ENTITIES[table].id.replace("id", `${row}.id`);
}

async function triggersFor(db: Kysely<unknown>): Promise<string[]> {
  const statements: string[] = [];
  for (const [table, { entity }] of Object.entries(ENTITIES)) {
    const name = table as keyof typeof ENTITIES;
    const cols = await columns(db, table);
    statements.push(
      `create trigger sync_${table}_insert after insert on ${table} begin
        ${mark(entity, `select ${rowId(name, "new")} as id`, 0)}
      end`,
      `create trigger sync_${table}_update after update on ${table} when ${changed(cols)} begin
        ${mark(entity, `select ${rowId(name, "new")} as id`, 0)}
      end`,
      `create trigger sync_${table}_delete after delete on ${table} begin
        ${mark(entity, `select ${rowId(name, "old")} as id`, 1)}
      end`,
    );
  }
  for (const { table, entity, key } of EMBEDDED) {
    const cols = await columns(db, table);
    const prefix = `sync_${table}_${entity}`;
    statements.push(
      `create trigger ${prefix}_insert after insert on ${table} begin
        ${mark(entity, `select new.${key} as id`, 0)}
      end`,
      `create trigger ${prefix}_update after update on ${table} when ${changed(cols)} begin
        ${mark(entity, `select new.${key} as id union select old.${key}`, 0)}
      end`,
      `create trigger ${prefix}_delete after delete on ${table} begin
        ${mark(entity, `select old.${key} as id`, 0)}
      end`,
    );
  }
  // Disabling or enabling a connection hides or shows everything it reported, and its label is
  // shown inside every parcel it reported: all of those are changes for clients.
  const linked = (table: string, key: string): string =>
    `select ${key} as id from ${table} where connection_id = new.id`;
  statements.push(
    `create trigger sync_connections_reach after update on connections
      when old.state is not new.state or old.label is not new.label begin
        ${mark("parcel", linked("parcel_connections", "parcel_id"), 0)}
        ${mark("event", "select cast(e.id as text) as id from parcel_events e join parcel_connections pc on pc.parcel_id = e.parcel_id where pc.connection_id = new.id", 0)}
        ${mark("order", linked("order_connections", "order_id"), 0)}
        ${mark("return", linked("return_connections", "return_id"), 0)}
      end`,
    // An event's own time of change, for clients; not a change itself (see IGNORED).
    `create trigger sync_parcel_events_stamp_insert after insert on parcel_events begin
      update parcel_events set updated_at = ${NOW} where id = new.id;
    end`,
    `create trigger sync_parcel_events_stamp_update after update on parcel_events
      when new.updated_at is old.updated_at begin
      update parcel_events set updated_at = ${NOW} where id = new.id;
    end`,
  );
  return statements;
}

/** Drops every sync trigger and creates them again for the tables' current columns. */
export async function createSyncTriggers(db: Kysely<unknown>): Promise<void> {
  const existing = await sql<{
    name: string;
  }>`select name from sqlite_master where type = 'trigger' and name like 'sync\\_%' escape '\\'`.execute(
    db,
  );
  for (const { name } of existing.rows) {
    await sql`drop trigger ${sql.id(name)}`.execute(db);
  }
  for (const statement of await triggersFor(db)) {
    await sql.raw(statement).execute(db);
  }
}
