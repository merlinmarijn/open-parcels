# 0005: Consumers: installable outputs for events (ntfy, email, …)

- **Status:** proposed 2026-11-25 (owner's idea; draft, scheduled after TODO §3 provider rewrite).
- **Builds on:** 0002 (installable providers, tiers, sandbox, repo manifest), 0004 (Android app,
  UnifiedPush), glossary ("Consumer", owner's choice 2026-11-25).

## 1. Idea

Providers bring information in (carriers, shops, inboxes). **Consumers** take open-parcels' events
out to somewhere the user wants them: an ntfy topic, an email address, a webhook, MQTT, a chat app.
The user installs and configures a consumer the same way as a provider ("Add a consumer → ntfy →
server, topic, token"). A repository may ship providers, consumers and themes together; its manifest
lists each.

## 2. Counter-arguments considered, and the answer to each

| Concern | Answer |
| --- | --- |
| **Installable code that receives every parcel event is a privacy risk**: a consumer sees names, addresses, items, courier positions. | Consumers run in the same sandbox as providers (0002): no network except the hosts they declare (the user's ntfy server, SMTP host), secrets per call, tiers and trust warnings. A consumer declares which event fields it needs; it never gets courier positions unless it asks and the user agrees. |
| **Reinventing Apprise**: Apprise already speaks to 100+ services (ntfy, Gotify, Telegram, Discord, Matrix, Pushover, email, …). | Agreed, so the built-in set stays small and includes an **Apprise consumer** that sends to a user's `apprise-api` container. Dedicated consumers are only worth it where they do more than a text message (ntfy actions and click-through links, email with HTML and pictures, MQTT with retained state). |
| **Home Assistant already does notifications** for HA users. | Consumers are for everyone without HA (Docker/Unraid installs, the Android app's UnifiedPush). HA users keep using HA's notify; the HA integration stays an event client, not a consumer. |
| **Notification spam / duplicates** (owner rule: every notification, but no duplicates). | Rules live in open-parcels, not in each consumer: one notification per parcel state change, de-duplicated across connections and providers, with per-consumer filters (which events, which directions, quiet hours, digest). Consumers only format and deliver. |
| **A failing consumer must not block anything.** | Delivery runs from the existing event outbox with retries and backoff per consumer; a dead ntfy server never holds up tracking. Status page shows each consumer's last delivery. |
| **Two package formats are twice the work.** | One format: the 0002 manifest gets a `consumers:` list next to `providers:` and `themes:`; same install, update, tiers and registry. |

My take: build it, but with a small built-in set and the rules engine in the core.

## 3. Proposed shape

- **Built-in consumers** (tier Built-in): ntfy, email (SMTP), webhook (JSON, signed with an HMAC
  secret), Apprise (via `apprise-api`). Later candidates: MQTT, Gotify, Matrix, Telegram.
- **Installable consumers** (Verified / Custom / Community tiers) via the 0002 registry, for anything
  else.
- **Notification rules** in the core: events to send (new parcel, out for delivery, at pickup
  point, delivered, delay, return deadline, refund, sign-in needed, backup failed, …), direction
  (receiving / sending), connections, quiet hours, digest (immediately / hourly / daily), language
  (EN/DE).
- **Consumer API** (in the provider kit): `describe()` (form, declared hosts, needed fields),
  `deliver(notification, config, secrets)` → ok / retry-after / permanent failure; optional
  `test()` for a "Send test notification" button.
- **Android app (0004):** its UnifiedPush endpoint is simply an ntfy consumer the app registers
  for itself, so the app and the consumer model share one path.

## 4. Order

After TODO §3 (provider manifest, sandbox, registry), because consumers reuse all of it. The
notification rules and the built-in ntfy / email / webhook consumers can start as soon as the
manifest format exists.
