# Changelog

## Unreleased (2.0.0-dev)

### Changed (breaking): one word per concept ([`docs/glossary.md`](docs/glossary.md))

Code, API, database, live events, web UI and docs now use the glossary's terms. The old names are
**gone, not deprecated**: the server neither sends nor accepts them.

| Old (removed) | New |
| :--- | :--- |
| `/api/v1/sources…` | `/api/v1/connections…` |
| `plugin` (connection, connection ref; `POST /api/v1/connections` body) | `provider` (required when adding a connection) |
| `source_kinds` (`GET /api/v1/carriers`) | `connection_kinds` |
| parcel `sources` with `source_id` | `connections` with `connection_id` |
| `barcode` (parcels, orders' parcels, calendar entries; `POST /api/v1/parcels` body) | `tracking_number` (required when adding a parcel) |
| `planned_from` / `planned_to` | `expected_from` / `expected_to` |
| `direction` `incoming` / `outgoing`, `legacy_direction` | `direction` `receiving` / `sending` |
| live events `source.*` | `connection.*` |
| live events `parcel.outgoing_registered` / `parcel.outgoing_delivered` | `parcel.sending_registered` / `parcel.sending_delivered` |
| `positionAt` in `parcel.live_position` | `position_at` |
| `invalid_source`, `source_backing_off` error codes | `invalid_connection`, `connection_backing_off` (same HTTP statuses, 400 and 429) |
| web UI address `/sources` | `/connections` (no redirect) |

**Stored data is migrated on start:** migration `0019-glossary-names` renames tables, columns and
directions; `0020-ha-import-markers` rewrites Home Assistant import markers to the new shape. Live
events stored before the upgrade are dropped, so a client reconnecting with an older
`Last-Event-ID` gets `resync` once and reloads over REST.

**What clients must do:** use the new names above. The Home Assistant integration, the Home
Assistant app and the browser extension are released in lockstep with this server version; an
older Home Assistant integration stops seeing connections and live events until it is updated.
Scripts that call the API by hand must switch paths and fields; nothing else is needed.

### Added: the web UI in English and German

The web UI follows the browser's language (English or German) and can be set under
**Settings → Language**; dates, times, numbers and amounts are formatted in the user's locale.
German texts use the German terms in [`docs/glossary.md`](docs/glossary.md). Error texts written
by individual providers or carriers stay as they are.

### Changed (breaking): error bodies carry `params`, the UI shows its own texts

Every error body is now `{ error, message, params }`. `error` is one of a fixed list of codes (see
`docs/openapi.json`); `message` stays an English explanation for scripts and logs; `params` holds the
values a client's own text needs (`resource` for `not_found`, `seconds`, `reason`, `detail`, …). The
web UI shows an English or German text per code instead of the server's message.

- Fastify's own refusals (unknown content type, bad JSON, body too large) are `invalid_request`
  with the status they had, no longer `fst_err_…` codes.
- A failed backup before deleting everything is `delete_backup_failed` (was `backup_failed`).
- `DELETE /api/v1/settings/config/{key}` for a key that is no setting stays 404 `not_found`; other
  refusals of that call are 400 `invalid_setting` with a `reason`.

### Changed (breaking): server texts by language, setting groups as ids

- `GET /api/v1/settings/config`: `group` is an id (`storage`, `server`, `security`, `tracking`,
  `retention`, `backups`, `map`; was the English name, e.g. `Storage`) and `key` is a fixed list.
  `description` stays English; the web UI has its own text per setting key.
- The server reads `Accept-Language` (English or German, English otherwise) for the texts it
  writes itself: sign-in flow labels, sign-in step texts and field labels, the `title` and
  `description` of every field in `config_schema` and `secret_schema` (`GET /api/v1/carriers`,
  `GET /api/v1/connections/{id}/sign-in/flows`), and map layer `label` and `attribution`
  (`GET /api/v1/map/layers`). Every provider form field now has a `title`. A flow without its own
  label is named `No sign-in`, `Username and password` or `API key` (was its type).
- Calendar entries (`GET /api/v1/calendar`) add `drop_off` and `cost`, shaped as on the return
  (parcels: `[]` and `null`), for clients with their own texts; `details` stays the English lines,
  as in the ICS feed.

**What clients must do:** read setting groups as ids. The Home Assistant integration does not use
them.

### Changed: backups are private, versions name their commit

- Backups (and the unfinished `.partial`) are written with mode 0600 and the backup folder with
  0700; on start, the server restricts backups written earlier the same way.
- Versions are `2.0.0-dev.<date>` until 2.0.0. The image bakes in its commit
  (`OPENPARCELS_COMMIT`, a build argument); `GET /api/v1/status` and diagnostics return it as
  `commit`, and the Status page shows `Version 2.0.0-dev.20261125 (abc1234)`.
- `GET /api/v1/status` returns `install_id`, a random id kept for the life of the install, so
  clients such as the Home Assistant integration can recognise the same server (HA-010).

### Changed: third-party services (OP-079)

- **Background place lookup is off by default** for new installs (`OPENPARCELS_GEOCODING`).
  Migration `0023-geocoding-opt-in` saves `true` as a Settings page value for an existing install
  that ran with the old default and does not set the variable in its environment, so nothing
  changes there until you switch it off under **Settings → Map**.
- New settings: `OPENPARCELS_GEOCODING_URL` (Nominatim-compatible search endpoint),
  `OPENPARCELS_CONTACT_EMAIL` (added to the User-Agent), and `OPENPARCELS_MAP_OSM_URL`,
  `OPENPARCELS_MAP_TOPO_URL`, `OPENPARCELS_MAP_EOX_URL` to move the built-in layers elsewhere.
- The tile cache honours `Cache-Control` / `Expires` (a week when absent) and refreshes stale tiles
  with conditional requests. Tiles cached before keep aging by their file time.
- The OpenStreetMap credit links "Report a map issue"; the satellite layer is labelled
  "non-commercial use only" and credits the imagery year it serves; the address search shows the
  OpenStreetMap/ODbL credit. Terms and switching: [`docs/third-party-services.md`](docs/third-party-services.md).

### Removed (breaking): unused older routes (OP-059)

- `GET /tiles/{z}/{x}/{y}.png` (use `GET /tiles/osm/{z}/{x}/{y}`), and
  `POST /api/v1/connections/{id}/sign-in/start` / `…/sign-in/finish` (use the sign-in attempts:
  `POST …/sign-in/attempts`, then `…/attempts/{attempt}/continue` with `{"input": {"pasted": "…"}}`). No
  client of ours called them.
- Migration `0024-dead-schema` drops the unused `image_cache` table and the never-read
  `parcels.dimensions` and `parcels.manual_until` columns.

### Fixed

- **A carrier host that answers 429 (or 503 with `Retry-After`) is left alone by every
  connection** until the pause it asked for is over (at least 60 s, at most 24 h). Before, only
  the connection that met the limit waited, and a second account, a live read or a sign-in step
  could ask the same host again at once. The pacing of every provider is documented in
  [`docs/third-party-services.md`](docs/third-party-services.md).
- An inbox whose mail server accepts the connection but fails every sync backs off up to 15
  minutes instead of reconnecting every 30 seconds: the backoff now resets only after a whole sync.
- The web UI refreshes when retention archives a parcel (`parcel.archived`) and when an email
  starts an order (`order.created`); it ignored both before. The stream's message types are now
  listed in the API document, so the UI's handling is checked against the server's list (OP-052).
- `X-Next-Offset` on `GET /api/v1/parcels` is sent only when another page really follows, not on
  every full page (OP-053).
- Diagnostics, the API document and every User-Agent report the running version from
  `server/package.json` instead of three hard-coded ones (OP-056).
- Folding a shop's parcel into its carrier's keeps the time the owner set a manual status
  (`manual_at`) with that status (OP-058).
- **Live courier sessions survive a restart.** A stored session now names the connection that
  follows it, so the first run of another connection of the same parcel no longer ends it
  (migration `0022-live-state-connection`; sessions stored before the upgrade are dropped once and
  start again on their connection's next poll).
- Connections leaving the quiet window poll a few minutes after 00:00 and 06:00 instead of on the
  hour; a stale map tile is served at once while it refreshes in the background; parcel collages
  are only cached when every picture loaded, and pruned after 30 days; API tokens record their use
  at most once a minute.

### Added

- **Scheduled database backups** while the server runs (`OPENPARCELS_BACKUP_HOURS`, default 24;
  `OPENPARCELS_BACKUP_KEEP`, default 7; `OPENPARCELS_BACKUP_DIR`, default `backups/` in the data
  folder; all three also under **Settings → Backups**). A Backups card on the Settings page shows
  the newest result and the files kept and has **Back up now**; `GET`/`POST /api/v1/data/backups`;
  live event `backup.finished` (`ok`, `reason`, `file`, `bytes`, `error`). A restore tool,
  `node server/dist/tools/restore-backup.js <file> [--dry-run] [--force]`, checks a backup and puts
  it in place with the server stopped (README, "Backups and restore"). "Delete everything" now uses
  the same backup and deletes nothing when it fails (500 `backup_failed`); its backups count
  towards the number kept.
- **Status of every part:** `GET /api/v1/status` (readers) lists every connection and inbox with
  its state, failures, next run and any pause a carrier asked for, the scheduler, the live event
  stream and backups; `GET /api/v1/health` (public, no details) answers `ok`, `degraded` (a
  connection or inbox in error or needing sign-in, failing backups, a stalled scheduler) or
  `unavailable` (503, the database does not answer). `/api/v1/health/ready`, which the Docker
  health check uses, still only checks the database, so a carrier's bad day never marks the
  container unhealthy. The Status page shows all of it and refreshes on live events.
- [`docs/decisions/0003-accounts.md`](docs/decisions/0003-accounts.md): one household per
  installation (admin and reader password, API tokens), no user accounts.

- **Orders from order emails.** Inbox connections now act on the rules' order emails
  (`order_placed`, `order_confirmed`, `order_shipped`, `order_delivered`, `order_cancelled`):
  confirmations of AliExpress, Temu, eBay, MediaMarkt, Mindfactory, reichelt, Netto Online,
  Rasppishop, KSP, Shopify shops and the digital stores start an order with its items and date,
  later emails move it on, and an order email's tracking numbers are filed under its order.
  Orders merge by shop and order number; a PayPal receipt that quotes a shop's reference joins
  that shop's order (whichever email comes first) and keeps its own order only while no shop
  claims the number. Shops on Shopify are named after the sender, so two shops' `#1042` differ.
- Order statuses `cancelled` (nothing of it arrived) and `refunded` (money back without a
  return); both archive the order. An order without parcels takes the shop's word for `shipped`
  and `delivered`.
- `digital` on orders: orders of digital stores (Steam, GOG, Humble, Fanatical, Eneba, GAMIVO,
  Instant Gaming, MMOGA) are delivered when bought and never wait for a parcel.
- Order totals as the emails state them (rules 2.0.0-dev.12): an order's `total` is the shop's
  stated total, else a payment receipt's until the shop states one, else the sum of its priced
  lines (migration `0021-order-totals`). Boykisser.gg order confirmations.
- **Fallback services** (optional connections, off until added): **Universal lookup** (a
  universal-lookup service's address) and **17TRACK** (your own API key, API v2.2). They are asked
  only about parcels no built-in carrier follows, or that their carrier has not found for a day,
  one service at a time, cached and paced (see the README); their answers are filed under the
  parcel's own carrier. A code no carrier recognises can be added while one exists.
  `GET /api/v1/carriers` says `fallback` per provider.
- Live event `order.created` when an email starts an order; its data is the order like
  `order.updated` (without parcels).

- `expected_days` on parcels (and orders' parcels): the expected delivery as local days
  (`YYYY-MM-DD`, server time zone) when it is whole days, else null. The web UI shows these days
  instead of guessing from the times in the browser's zone (OP-044).
