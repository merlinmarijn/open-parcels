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

### Added

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
- Live event `order.created` when an email starts an order; its data is the order like
  `order.updated` (without parcels).

- `expected_days` on parcels (and orders' parcels): the expected delivery as local days
  (`YYYY-MM-DD`, server time zone) when it is whole days, else null. The web UI shows these days
  instead of guessing from the times in the browser's zone (OP-044).
