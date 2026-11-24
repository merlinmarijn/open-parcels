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

- [ ] Hermes password once in the Hermes source
- [ ] DHL API key (approved?) into the DHL source
- [ ] Make `ghcr.io/open-parcels/open-parcels` public
