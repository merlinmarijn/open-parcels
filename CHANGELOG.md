# Changelog

## Unreleased (2.0.0-dev)

### Changed: one word per concept ([`docs/glossary.md`](docs/glossary.md))

Code, API, database, live events, web UI and docs now use the glossary's terms. Names that cross
a public boundary keep working **for one release** and are then removed:

| Old (deprecated) | New | How the old name keeps working |
| :--- | :--- | :--- |
| `/api/v1/sources…` | `/api/v1/connections…` | Every old path is served as the new one. |
| `plugin` (connection, connection ref) | `provider` | Sent next to `provider`; `POST /api/v1/connections` accepts `plugin`. |
| `source_kinds` (`GET /api/v1/carriers`) | `connection_kinds` | Sent next to it. |
| parcel `sources` with `source_id` | `connections` with `connection_id` | Both sent. |
| `barcode` (parcels, orders' parcels, calendar entries) | `tracking_number` | Both sent; `POST /api/v1/parcels` accepts `barcode`. |
| `planned_from` / `planned_to` | `expected_from` / `expected_to` | Both sent. |
| `direction` `incoming` / `outgoing` | `receiving` / `sending` | `direction` carries the new values; `legacy_direction` the old ones. Requests accept both. |
| live events `source.*` | `connection.*` | Each is followed by its old-named twin (no `id`), whose data has `source` (with `plugin`) next to `connection`. |
| live events `parcel.outgoing_registered` / `parcel.outgoing_delivered` | `parcel.sending_registered` / `parcel.sending_delivered` | Followed by the old-named twin. |
| web UI address `/sources` | `/connections` | Redirects. |

Not kept, because a value cannot carry two names: the error codes `invalid_source` and
`source_backing_off` are now `invalid_connection` and `connection_backing_off` (same HTTP
statuses, 400 and 429).

The database is migrated on start (migration `0019-glossary-names`). Live events stored before the
upgrade are dropped, so a client reconnecting with an older `Last-Event-ID` gets `resync` once and
reloads over REST.

**Home Assistant integration:** versions that read `direction == "outgoing"` count sending
parcels as receiving until they are updated to accept `sending`; everything else keeps working
through the deprecated fields and live events above.

### Added

- `expected_days` on parcels (and orders' parcels): the expected delivery as local days
  (`YYYY-MM-DD`, server time zone) when it is whole days, else null. The web UI shows these days
  instead of guessing from the times in the browser's zone (OP-044).
