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
| 9 | OP-130 (partly) | only the order-shop repair appends events; revival, barcode repair and mail clean-up do not |
| 12 | OP-085, OP-086 | non-refusals read as "sign in again"; no once-per-run renewal in five plug-ins |
| 14 | OP-063, OP-064 | orders paged in memory; web caps at 1,000 parcels / 500 orders |
| 15 | OP-148 | four parcel mutations per page, silent "Mark delivered" failure |
| 18 | OP-005 (partly), OP-010, OP-022, OP-042 | CSP is on `index.html` only; no `nosniff` on JSON/static |
| 17, 19–24 | all ids | none fixed yet |

- [ ] OP-063, OP-064: order paging in the database instead of memory; no silent 1,000/500 caps
- [ ] OP-005, OP-010, OP-022, OP-042: remaining hardening and lifecycle items
- [ ] OP-149, OP-151, OP-152, OP-154, OP-150, OP-153, OP-157, OP-038, OP-043, OP-073, OP-061,
      OP-041, OP-044: web correctness
- [ ] OP-072, OP-077, OP-158, OP-047, OP-045, OP-046, OP-076: build, styles and tooling
- [ ] OP-034, OP-039, OP-030, OP-031, OP-033, OP-027, OP-028, OP-029, OP-068: scheduler, live
      tracking, resolver and token writes
- [ ] OP-025, OP-065, OP-066, OP-069, OP-136, OP-137: migrations, start-up repairs, entrypoint,
      deployment drift
- [ ] OP-070, OP-142, OP-071, OP-162, OP-163, OP-164: missing and toothless tests
- [ ] OP-078, OP-075, OP-143, OP-015, OP-014, OP-079, OP-121: docs, fixtures, third-party terms
- [ ] OP-048 … OP-161 cheap clean-ups (group 24 of the audit order)

## 2. Production readiness

- [ ] Real accounts (per-user) or a documented single-household model; decide and document
- [ ] Backups: built-in scheduled database backup with retention, and a documented restore
- [ ] Upgrade path from v1 (`legacy-ts`) documented and tested on a copy of a real v1 database
- [ ] Observability: structured status page covering every source, mailbox, scheduler and event
      stream; health endpoint covers sources in error
- [ ] Rate-limit and failure behaviour reviewed for every carrier (no carrier may be hammered)
- [ ] Internationalisation of the web UI (at least English and German), dates in the user's locale
- [ ] Accessibility pass (keyboard, screen reader, contrast) on every page
- [ ] Mobile layout pass on every page
- [ ] Performance with 10,000 parcels / 5,000 orders (history import scale)
- [ ] Release 2.0.0: changelog, tags `2.0.0`, `2.0`, `latest` on Docker Hub and GHCR, website and
      Unraid template switched from `:dev` to `:latest`, HA app on the release
- [ ] Make `ghcr.io/open-parcels/open-parcels` public (owner click) and switch docs to it

## 3. Provider rewrite (decision record draft 0002, provider ecosystem)

- [ ] Turn the proposal into `docs/decisions/0002-providers.md` with the owner's decisions
- [ ] Manifest format and capabilities model; give every built-in carrier a manifest and enforce its
      declared hosts
- [ ] Provider sandbox (child process with Node permission model, broker for HTTP, secrets per call)
- [ ] Source actions and jobs (buttons on source cards, progress, cancel, resume, HA buttons)
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

- [ ] Rules: `payments-messages@amazon.*` "Refund on order …" mails (22 unread in the backup)
- [ ] Return mails of other shops (generic rules), PayPal refunds matched to orders
- [ ] Move return detail reading (deadline, drop-off, cost) from the server into the rules/providers
- [ ] Verify the Amazon return-window parsing on a live account run
- [ ] Re-read old mail on demand so past returns appear (part of "Clear data" / history import)

## 5. New sources (from the mail backup inventory)

- [ ] Reichelt, Berrybase, boykisser.gg (order history where offered, else mail)
- [ ] AliExpress (578 mails), PayPal (purchase receipts), eBay, Temu, MediaMarkt, Mindfactory,
      sertronics.shop, Steam / Humble / GOG / Instant Gaming / gamivo / mmoga (digital orders)
- [ ] 17track as a fallback tracking source

## 6. Home Assistant integration (open-parcels-ha)

- [ ] Returns: sensor and attributes, calendar entries with drop-off and cost lines
- [ ] Source actions as buttons/services once the server has them
- [ ] Remaining low findings HA-009 … HA-032
- [ ] Publish a GitHub release for HACS users (tag v0.4.0 exists)

## 7. Home Assistant app (open-parcels-ha-apps)

- [ ] AP-016: use the published image instead of building from source on the HA host
- [ ] AP-010, AP-011: one options mapping (server's supervised mode) and option precedence
- [ ] AP-008: consistent database backups (backup mode or SQLite backup before HA backups)
- [ ] Bump to every server release automatically (script)

## 8. Browser extension (open-parcels-extension)

- [ ] EX-001: deliver captured sign-in URLs only to the approved open-parcels origin
- [ ] EX-002, EX-007, EX-012: one pending-request map, rate-limit approval windows
- [ ] EX-006, EX-010: persistent timeouts across service-worker restarts
- [ ] EX-016: testable background logic with tests
- [ ] EX-003, EX-014, EX-015: approval prompt shows what is captured; no plain-http origins
- [ ] EX-004, EX-005: dynamic content scripts; decide on HA ingress support
- [ ] Signed releases; store publishing (walk the owner through it)

## 9. Website and org profile

- [ ] Remaining WS and GH low findings; docs for returns, Data page, Tailscale, geocoding switch
- [ ] Issue forms with a "no personal data" checkbox, CODE_OF_CONDUCT, SUPPORT, PR template

## 10. Owner actions

- [ ] Hermes password once in the Hermes source
- [ ] DHL API key (approved?) into the DHL source
- [ ] Make `ghcr.io/open-parcels/open-parcels` public
