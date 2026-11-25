# Done

Shipped work, newest first, with the commit that shipped it.

## 2026-11-25

- OP-079 third-party services: background place lookup opt-in with migration 0023, configurable
  Nominatim endpoint and contact (`24fe477`); tile cache headers, conditional refresh, built-in tile
  URL overrides, OSM map-issue link, EOX non-commercial label and year (`6cd2b6a`);
  `docs/third-party-services.md` (`c6c33b8`)

## 2026-11-25

- TODO §1 tests: OP-070 start-up/shutdown over broken connections (`main.ts` → `startServer`),
  IMAP client, throttle per forwarded client (`cdb1527`); OP-142 CLI tools with injected argv,
  mail interpreter details (`a8eb732`); OP-071 base path and `apiFetch` (`4f9099a`); OP-163
  `useLiveUpdates` with a fake EventSource, schema helpers, `regressions.test.tsx` split beside its
  modules (`4ee05d4`)
- Group 24 clean-ups: OP-058 (`673c02d`), OP-052 with `parcel.archived`/`order.created` now
  refreshing the UI (`a28b048`), OP-159/160/161 (`7b93639`), OP-048, OP-049, OP-053, OP-054,
  OP-056, OP-059 (unused routes removed), OP-060, OP-062, OP-138, OP-140, OP-141 (`5b3aa9c`);
  remainders in TODO §1

## 2026-11-24

- TODO §1 remainder: build, styles and tooling OP-045 (`8d58625`), OP-046 (`d5bc19c`), OP-047
  (`6f7a5ff`), OP-072 (`a37b133`), OP-076 (`b640936`), OP-077 (`1d875fa`), OP-158 (`03cb315`);
  scheduler and live tracking OP-034 (`d9f6e0d`), OP-039 and OP-031 (`a6ae9b0`), OP-030
  (`2e1c366`), OP-033 (`95dfdb3`); resolver, tiles, images, tokens OP-027, OP-028, OP-029, OP-068;
  migrations and deployment OP-025, OP-065, OP-066, OP-069, OP-136, OP-137; tests OP-162
  (`8236b21`), OP-164 (`a873065`), OP-149 (`170bb92`), OP-153 (`03134e7`), OP-073 (`7e84afe`);
  fixtures OP-014 and OP-121 (`c5b4d63`); docs OP-143, OP-015, OP-075, OP-078 (`eca0df8`)
- Migrate, don't keep legacy code (owner decision): the glossary rename's one-release aliases are
  gone (`/api/v1/sources`, `plugin`, `source_kinds`, `sources`/`source_id`, `barcode`,
  `planned_*`, `legacy_direction`, old-named live events, `positionAt`, `/sources` redirect;
  `53148a0`), Home Assistant import markers migrated (0020, `2367cbd`), rule in AGENT.md, glossary
  and changelog (`862cb55`)
- Orders from order emails (TODO §4 order emails, §5 shop emails of rules dev.11): confirmations,
  shipping and delivery notices, cancellations, refunds without a return, digital orders, PayPal
  receipts merged into the shop's order, Shopify shops by sender, `order.created`
  (`ffb09f8`, web `3ed764e`, `256e7fe`)
- Rules 2.0.0-dev.13 (email API names, released from open-parcels-rules `d0e95c7`) with order
  totals from emails (shop's total wins over PayPal's, migration 0021) and Boykisser.gg
  (`938fde4`, `ef643c1`)
- Fallback services: engine hand-over (`a730d6e`), Universal lookup (`a09a5e8`), 17TRACK with the
  user's API key (`fdb9eb4`), README, glossary and changelog (`4b8686d`)
- Glossary pass in the server repo (TODO §3 first item, with OP-044): migration 0019 (sources →
  connections, barcode → tracking_number, planned → expected, incoming/outgoing →
  receiving/sending; `e32802c`), API with the old names kept for one release (`/api/v1/sources`
  paths, `barcode`, `planned_*`, `legacy_direction`, `sources`/`plugin`/`source_kinds`, old-named
  live event twins; `cf60b56`), `expected_days` for whole-day expected deliveries (OP-044,
  `daa51ca`), code identifiers and texts (`1315582`), web UI (`457bc87`), lint boundary
  (`371c662`), README, agent notes, decision records and `CHANGELOG.md` (`c52a191`). The other
  repos' share is listed in TODO §3
- Rules 2.0.0-dev.11 on the server: order, shipping and return emails for AliExpress, PayPal
  receipts (matched by shop reference), Steam, Humble, GOG, Instant Gaming, GAMIVO, MMOGA, Eneba,
  Fanatical, eBay, Temu, MediaMarkt, Mindfactory, reichelt, Netto, Rasppishop and KSP; the new
  `order_delivered` event is ignored like every order event for now (TODO §4) (`486eac6`)
- Web correctness: route map redraws only on change (OP-149, `8eb9ab1`); settings editor, secrets
  and reader password (OP-152, `29ed45b`); sign-in loose ends, extension 0.2.0 hints for enabling
  it, `busy`/`error` reasons and the Home Assistant frame (OP-154, OP-038, `a57d551`); split orders
  and unknown currencies, sources section (OP-151, OP-157, `2f76956`); maps follow a mode change
  (OP-150, `f3095a6`); "All" orders tab, calendar asks once for the right range (OP-153,
  `db55eca`); session and live-stream recovery, Retry-After dates, live courier position (OP-073,
  OP-043, OP-041, OP-061, `fbf4bd6`)
- Home Assistant app follow-ups on the server: only the app's options are mapped (time zone,
  archive and delete days dropped), data folder `/data/open-parcels`, "Home Assistant app option"
  as a value's origin, a log line when a saved setting overrides an option (`fbc9538`)
- Rules 2.0.0-dev.10 on the server: Amazon "Refund on order …" mails (`4879801`)
- Installable themes with a separate mode recorded: TODO §3, decision 10 in 0002, glossary
  (`8cf7a65`)
- open-parcels-ha 0.5.0: returns sensor, events and calendar, HA-009…HA-031 lows; released and
  deployed to the owner's Home Assistant
- open-parcels-ha-apps: AP-005, AP-007, AP-008, AP-011, AP-013, AP-015, AP-018…AP-022 (app
  2.0.0-dev.20261124.3: cold backups, watchdog, admin-only panel, pinned base image; open-parcels-ha-apps
  `6ac768e`); AP-017 (non-root) skipped, needs testing on a real Home Assistant install
- Website WS-006…WS-016; org profile GH-011…GH-014
- Orders: only the page's orders are built, the view is decided from the order rows and their
  parcels' states; the web reads every page instead of stopping at 1,000 parcels / 500 orders
  (OP-063, OP-064, `3ebf2ea`)
- Hardening and lifecycle: base images pinned by digest and `sharp` exactly (OP-010, `0fccb4f`),
  `nosniff` on every answer (OP-005, `e7c9f18`), an expected delivery the carrier withdrew is
  cleared (OP-022, `dad0d1d`), an order total with unpriced items says "from" (OP-042, `9a3750c`)
- Glossary: one word for every concept, the owner's choices (`docs/glossary.md`, `6d72b58`)
- Audit leftovers of groups 9, 12 and 15: only real refusals ask for a new sign-in and one
  renewal per run (OP-085, OP-086, `cfefd66`); start-up repairs fire events (OP-130, `77e5369`);
  a refused parcel edit is shown and reloads the parcel (OP-148, `3b5277c`)
- "Now" audit ids verified against `main`; the open ones are listed in `TODO.md` §1 (`6ad61d2`)
- Decision record 0002, installable providers with trust tiers (`4bdd26b`)
- open-parcels-ha v0.4.0 released for HACS users
- open-parcels-ha-apps: prebuilt image `bluscream1/open-parcels-ha-app` (amd64 + arm64) instead of
  building on the host (AP-016), `run.sh` removed and the options read by the server's supervised
  mode (AP-010); app 2.0.0-dev.20261124.2 on server `10d7e31` (open-parcels-ha-apps `5bc9001`)
- open-parcels-extension 0.2.0: EX-001…004, EX-006…018 and EX-020 fixed; EX-005 documented as not
  supported (Home Assistant ingress shares its origin) (open-parcels-extension `c770dc6`)
- Org profile: issue forms with a personal-data check, PR template, SUPPORT, CODE_OF_CONDUCT
  (open-parcels/.github `4d2d154`); website pages for returns, the Data page, privacy and
  Tailscale (open-parcels.github.io `0a0ac40`)
- Rules: Amazon "Refund on order …" mails (open-parcels-rules `603a404`; reaches the server with
  the next rules release)
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
