# Done

Shipped work, newest first, with the commit that shipped it.

## 2026-11-24

- Returns: return records per order (deadline, drop-off options, free or cost, label, refund,
  return parcel), Amazon return window, Amazon return mails, `/api/v1/returns`, `return.*` events,
  "Return by" calendar/ICS entries, Returns page and order section; never on the map (`10d7e31`)
- Rules 2.0.0-dev.9: no catastrophic backtracking on whitespace, no crash on bad character
  references or deep JSON-LD, linear HTML-to-text, schema.org only from known senders with http(s)
  links (`5a60118`)
- Audit fixes (34 commits, `47fcf25`…`a2b5d58`): unreadable mailbox no longer stops the server,
  validated configs and secrets, UPS without a key, order-shop repair keeps items, access rule on
  encoded paths, Retry-After 0, one guarded transport, sign-out clears data, honest imports,
  manual delivery archived, geocoding switch, courier shown until delivery, stable HA discovery
  token, reader-password warning once, secure cookies over HTTPS, private mail subjects, calendar
  pictures through the proxy, carrier fixes (six tracking plug-ins, Amazon US dates, missing account
  lists, Poczta Polska), mail over STARTTLS only, join indexes, web keyboard and link fixes
- Licence: the Unlicense on every repo

## 2026-11-23

- Data page: sizes and counts, delete archived / older / raw / scans, clear caches, delete
  everything with backup (`e021a7f`)
- No automatic deletion by default, "Clear data" per source, bounded event outbox (`1841233`)
- Parcels and orders of disabled sources are hidden everywhere (`61d0e93`)
- Strict content security policy and security headers (`5e7f73f`)
- Built-in Tailscale, no sidecar (`5b98e88`); default branch renamed to `main`
