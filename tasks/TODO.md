# To do

Everything that still has to happen before open-parcels is production-ready for thousands of
users. Work top to bottom; move an item to `WIP.md` when starting it and to `DONE.md` (with the
commit) when it is shipped. Ids refer to the audits (`OP-` server, `RU-` rules, `HA-` Home
Assistant integration, `AP-` Home Assistant app, `EX-` extension, `WS-` website, `GH-` org profile).

## 1. Core hardening (server + web, audit "Now" items not yet shipped)

Verified against `main` at `0f6b858` (2026-11-24). Groups 1–16 are fixed with a regression test
in the commit except the ids below; of groups 17–24 only OP-020 (no test), OP-021 and OP-026 were
already fixed. Still open, by audit group:

| Group | Open | Note |
|---|---|---|
| 17, 19–24 | all ids | none fixed yet |

- [ ] OP-070, OP-142, OP-071, OP-163: missing tests (OP-162 and OP-164 shipped; the new web tests
      cover OP-149, OP-153 and OP-073 only)
- [ ] OP-048 … OP-161 cheap clean-ups (group 24 of the audit order)

## 2. Production readiness

- [ ] Real accounts (per-user) or a documented single-household model; decide and document
- [ ] Backups: built-in scheduled database backup with retention, and a documented restore
- [ ] Upgrade path from v1 (`legacy-ts`) documented and tested on a copy of a real v1 database
- [ ] Observability: structured status page covering every connection, inbox, scheduler and event
      stream; health endpoint covers connections in error
- [ ] Rate-limit and failure behaviour reviewed for every carrier (no carrier may be hammered)
- [ ] Internationalisation of the web UI (at least English and German), dates in the user's locale
- [ ] Accessibility pass (keyboard, screen reader, contrast) on every page
- [ ] Mobile layout pass on every page
- [ ] Performance with 10,000 parcels / 5,000 orders (history import scale)
- [ ] Release 2.0.0: changelog, tags `2.0.0`, `2.0`, `latest` on Docker Hub and GHCR, website and
      Unraid template switched from `:dev` to `:latest`, HA app on the release
- [ ] Make `ghcr.io/open-parcels/open-parcels` public (owner click) and switch docs to it

## 3. Provider rewrite (decision record draft 0002, provider ecosystem)

- [ ] Glossary pass in the other repos, in lockstep with the server (the server repo is done, see
      `DONE.md`; it no longer serves any old name, `CHANGELOG.md`):
  - open-parcels-ha: read `/api/v1/connections`, `tracking_number`, `expected_from`/`expected_to`
    (and `expected_days` for whole-day dates in sensors and the calendar), `direction`
    `receiving`/`sending` (today `!= "outgoing"` counts sending parcels as receiving), live events
    `connection.*` and `parcel.sending_registered`/`_delivered` (`const.py`); send
    `tracking_number` and `receiving`/`sending` in `add_parcel`; rename the `barcode` attribute to
    `tracking_number`, source devices/buttons/translations to
    connections (entity and device ids kept), Home Assistant event names with "sending"; texts:
    Inbox, email, Log in (web UI) vs Sign in (carrier)
  - open-parcels-ha-apps: option descriptions, translations, DOCS/README and changelog text
    (connection, provider, inbox, email, Log in); nothing API-facing
  - open-parcels-extension: README, store texts and UI strings (provider, connection, Sign in);
    the page/extension `postMessage` field `source` is DOM protocol and stays
  - website (open-parcels.github.io): guides, carrier list and API examples (`/api/v1/connections`,
    `tracking_number`, `expected_from`), providers not plug-ins, connections not sources, inbox,
    email, tracking number, Receiving/Sending, Log in vs Sign in
  - .github org profile: README terms (provider, connection, email, tracking number)
  - open-parcels-rules (another agent is on it): docs "mail" → "email" where it means a message;
    `MAIL_SOURCES` (subject/text/html) names parts of an email, not a connection, so a rename to
    "parts" avoids the clash; `trackingNumbers` already fits
- [ ] Manifest format and capabilities model; give every built-in carrier a manifest and enforce its
      declared hosts
- [ ] Themes: replace the light/dark-only setting with installable themes. Two separate settings:
      Theme (default, installed themes) and Mode (Automatic from device / Light / Dark); a theme
      may ship a light and a dark variant (Automatic follows the device), or one variant that
      fixes the mode. A theme is declarative only (design tokens: colours, fonts, radius, spacing,
      map style, logo/icons; no JS, no external URLs — bundled assets only, CSP stays strict), so
      community themes can't run code or leak data. Distributed standalone or inside a provider
      repo (the repo manifest lists themes), installed from the providers page with the same tiers
      and trust warnings. Precondition: the web UI must use design tokens (CSS custom properties)
      everywhere, no hard-coded colours.
- [ ] Provider sandbox (child process with Node permission model, broker for HTTP, secrets per call)
- [ ] Connection actions and jobs (buttons on connection cards, progress, cancel, resume, HA
      buttons)
- [ ] Amazon "Import history" job (all years, resumable, conservative pacing, imported history kept)
- [ ] Mail routing: mailboxes dispatch matching mails to providers' `parseMail` (sender domain +
      DKIM check, global switch on by default)
- [ ] Split `open-parcels-rules`: provider data into providers, slim shared core stays
- [ ] One repo with a folder per provider for the official providers; repo manifest lists them
- [ ] Registry repo (verified tier, signed index, blocklist), custom git URLs, community discovery
      via the `open-parcels-provider` topic (on by default, yellow warning, review-prompt copy button)
- [ ] Providers page: installed / available tabs, tier badges, install from URL, auto-update
      (on for built-in and verified, opt-in for custom and community)
- [ ] Port the audit's "rewrite" items (OP-088 … OP-139) as acceptance tests of the new kit
- [ ] OP-108: decide on the DHL Poland proof-of-work

## 4. Returns follow-ups

- [ ] Return mails of other shops (generic rules), PayPal refunds matched to orders
- [ ] Move return detail reading (deadline, drop-off, cost) from the server into the rules/providers
- [ ] Verify the Amazon return-window parsing on a live account run
- [ ] Re-read old emails on demand so past returns appear (part of "Clear data" / history import)
- [ ] PayPal refund emails name no order number (rule `return-paypal`): match them to orders by
      amount and payee, or have the rules extract the shop's reference
- [ ] Order emails whose shipping part has a tracking number but no carrier the rules detect are
      dropped; with a fallback service they could become parcels filed under it

## 5. New connections (from the email backup inventory)

- [ ] Berrybase, sertronics.shop: order history where offered, else email rules
- [ ] Banggood: needs sample emails before rules can be written
- [ ] Fallback services on a private network: the HTTP layer refuses non-public addresses, so a
      universal-lookup service on the LAN cannot be used; decide on an opt-in per connection
- [ ] Unkeyed fingerprints of Home Assistant import markers (written before keyed ones) are still
      recognised (`legacyFingerprint`); they cannot be migrated without the HA credentials, so
      drop the fallback once no install has such markers

## 6. Home Assistant integration (open-parcels-ha)

- [ ] Source actions as buttons/services once the server has them
- [ ] HA-032 (the other lows shipped in 0.5.0)

## 7. Home Assistant app (open-parcels-ha-apps)

- [ ] AP-017: run as non-root; needs testing on a real Home Assistant install
- [ ] Bump to every server release automatically (script)

## 8. Browser extension (open-parcels-extension)

- [ ] Server follow-ups of extension 0.2.0: `docs/extension-protocol.md` (bridge only on sites
      enabled from the toolbar; enable + per-request approval with Allow once / Always allow /
      Deny and a 10-minute cool-down after Deny; cancel reasons `busy` and `error`; main-frame
      watching, results only to the requesting origin; stored state = approval choices, refused
      hosts, storage.session)
- [ ] Signed releases; store publishing (walk the owner through it)

## 9. Website and org profile

- [ ] Remaining WS and GH low findings

## 10. Owner actions

- [ ] Hermes password once in the Hermes connection
- [ ] DHL API key (approved?) into the DHL connection
- [ ] Make `ghcr.io/open-parcels/open-parcels` public
