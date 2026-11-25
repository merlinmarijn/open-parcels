# Delta sync

`GET /api/v1/sync?since=<cursor>&limit=<n>` lets a client (the Android app, a client library)
keep a full offline copy of parcels, events, orders, returns and connections and update it with
only what changed, deletions included (decision record 0004 §5, §6).

## Using it

1. First sync: call without `since` (or `since=0`). Store every entity of the answer.
2. While `more` is `true`, call again at once with `since=<cursor>`.
3. Keep the last `cursor`. Later (on a timer, on a live event, or on a push) call with it again.
4. Apply each page in order: replace the stored entities of `parcels`, `events`, `orders`,
   `returns` and `connections` by id, then remove every entity listed in `deleted`
   (`{type, id}`, `type` one of `parcel`, `event`, `order`, `return`, `connection`).
5. On `410 sync_expired` drop the copy and start again at step 1.

`limit` is 1–1000 (default 500); it counts changed entities, not objects in the answer.

## What the cursor means

- The cursor is opaque: a string the client stores and sends back, never compares or computes
  with. (It is the position of the last change the page covered in the server's change list.)
- Every change to an entity moves the entity to the end of the change list, so a page never
  misses an entity: something changed while a client pages through is listed again later. An
  entity may therefore appear twice across pages; the later copy wins.
- An empty page returns the same cursor it was given.
- A cursor is valid until the deletions it may have missed are dropped: tombstones are kept for
  90 days. A cursor from before that, or one newer than anything on the server (the database was
  restored from a backup), gives `410 sync_expired`.

## What counts as a change

- Any change a client could see in the entity as the API returns it, including its embedded parts:
  a parcel's items, connections and courier, an order's lines, connections and parcels (an order's
  status follows its parcels), a return's items and connections.
- Not counted: a provider run that only saw the same data again (when a parcel was last seen or
  last looked up at its carrier). `connections[].last_seen_at` inside a parcel and
  `lookup.checked_at` can therefore be older in the copy than on the server; they are refreshed
  with the parcel's next real change.
- Connections change on every run (`last_run_at`, `next_run_at`); they are few.
- Hiding counts as deleting: when every connection that reported a parcel, order or return is
  disabled, the entity (and a parcel's events) comes under `deleted`; enabling a connection again
  sends them as changed.
- A return's `expired` status follows the server's local day, not a change: a client with an old
  copy compares `return_by` with today itself.

## What is in the answer

- `parcels`: as `GET /api/v1/parcels/{id}` without `history`; their events come under `events`,
  each with its `id`, `parcel_id` and `updated_at`.
- `orders`, `returns`: as their own endpoints return them.
- `connections`: as `GET /api/v1/connections`: no sign-in data (only `has_secret`).

## How the server keeps it

Database triggers (`server/src/db/sync-triggers.ts`) write one row per changed entity into
`sync_changes` inside the statement that changed it, so a change and its sync entry commit or roll
back together and no writer can forget one. Each entity keeps only its newest row; a deleted one
keeps a tombstone. A migration that adds a column to a synced table calls `createSyncTriggers`
again so the new column counts. The hourly maintenance drops tombstones older than 90 days and
records how far it dropped them (the `sync_floor` setting).
