# open-parcels: guide for AI agents

open-parcels is a self-hosted parcel and order tracker. One server signs in to carriers and shops,
polls them, reads inboxes (IMAP), follows couriers live and publishes what it finds over a REST API
and a live event stream. This guide tells an agent (an AI assistant acting for the owner) how to
operate and debug it. It is served at `/llms.txt` and shown in the web UI under "For AI agents".

The full API contract is the OpenAPI document at `/api/v1/openapi.json`. Every path starts with
`/api/v1`. In the examples below `$OP` is the server's address (for example
`http://192.168.1.10:3000`) and `$TOKEN` an API token.

## Concepts

- **Parcel**: one box or envelope under one tracking number, with its history of events (each a
  status, a time and maybe a place). Statuses: `registered`, `in_transit`, `out_for_delivery`,
  `at_pickup_point`, `delivered`, `returning`, `problem`, `unknown`.
- **Order**: one purchase at a shop, with its items and parcels.
- **Return**: sending items back to a shop, with return-by date, drop-off, cost, label and refund.
- **Provider**: built-in code for one carrier, shop or service (DHL, Amazon, a fallback service).
- **Connection**: one configured use of a provider: a signed-in account, a keyless tracking setup
  or an inbox. States: `ok`, `idle`, `needs_sign_in`, `error`, `disabled`.
- **Inbox**: a connection (`kind: "mail"`, provider `imap`) to IMAP folders. The server watches it
  over IMAP IDLE and reads every new email with email rules.
- **Email rules**: data rules (sender, subject and body patterns, extractors) that turn an email
  into parcels, orders and returns. Three sets apply: the shared rules of the `open-parcels-rules`
  package, the rules of the provider whose domain sent the email (after a DKIM/DMARC check), and
  the owner's own custom email rules, saved in this server.
- **Action / job**: a button a provider offers on a connection ("Import history"); a task action
  starts a job with progress, which can be paused or cancelled.
- **Live event**: a message on the event stream (`parcel.status_changed`, `order.created`,
  `connection.state_changed`, `job.progress`, ...).

## Authentication

Send an API token as a bearer token: `Authorization: Bearer $TOKEN`. The owner creates tokens in
the web UI under "API tokens" (or `POST /api/v1/tokens`), each with scopes:

- `read`: everything you can see (parcels, orders, returns, connections, status, events).
- `write`: also add or delete parcels, run connections, start actions.
- `admin`: also tokens, settings, connections' settings and sign-in data, and the email lab (emails
  are personal data).

Ask for the smallest scope the task needs. A token is shown once; never print it back, log it or
put it into a URL (the event stream accepts only short-lived login tokens in its query).

```sh
curl -H "Authorization: Bearer $TOKEN" "$OP/api/v1/status"
```

## Key endpoints

| What | Request |
| --- | --- |
| Server health and every connection's state | `GET /api/v1/status` |
| Parcels (paged, `limit`/`offset`, `X-Next-Offset`) | `GET /api/v1/parcels?include_history=true` |
| One parcel with its history | `GET /api/v1/parcels/{id}` |
| Track a number (carrier detected when left out) | `POST /api/v1/parcels` `{"tracking_number": "..."}` |
| Orders, returns | `GET /api/v1/orders`, `GET /api/v1/returns` |
| Connections (inboxes have `kind: "mail"`) | `GET /api/v1/connections` |
| Run a connection now | `POST /api/v1/connections/{id}/sync` |
| Actions and jobs | `GET /api/v1/connections/{id}/actions`, `GET /api/v1/jobs` |
| Changes since a cursor (for a local copy) | `GET /api/v1/sync?since=...` |
| Live events | `GET /api/v1/events` (Server-Sent Events) |

```sh
curl -H "Authorization: Bearer $TOKEN" "$OP/api/v1/parcels?active=true&limit=50"
curl -H "Authorization: Bearer $TOKEN" "$OP/api/v1/connections"
```

Errors come as `{"error": "<code>", "message": "...", "params": {...}}`; the code is stable, the
message is English for logs. A 429 carries `Retry-After`: wait that long.

## The live event stream

`GET /api/v1/events` is a Server-Sent Events stream. Each message has `id` (a sequence number),
`event` (the type) and JSON `data`. Reconnect with the header `Last-Event-ID: <id>` to replay up to
24 hours of missed events; `resync` means reload over REST. Prefer listening to the stream over
polling the REST lists.

```sh
curl -N -H "Authorization: Bearer $TOKEN" "$OP/api/v1/events"
```

## The email lab (admin scope)

The email lab shows how the server reads an inbox's emails and lets you try email rules on them.
It opens a short-lived, read-only IMAP connection of its own; the inbox's watcher is not touched
and nothing is marked as read. Email content is personal data: it is never logged and never sent
in live events. Do not copy it anywhere the owner did not ask for.

| What | Request |
| --- | --- |
| Emails of a folder, newest first, with detection | `GET /api/v1/connections/{id}/email-lab/messages?folder=INBOX&since=YYYY-MM-DD&before=YYYY-MM-DD&limit=20&offset=0` |
| One email: headers, text, HTML as text, detection | `GET /api/v1/connections/{id}/email-lab/messages/{uid}?folder=INBOX` |
| Read one email with candidate rules | `POST /api/v1/email-lab/test` |
| Custom email rules | `GET /api/v1/email-rules`, `PUT /api/v1/email-rules/{rule}`, `DELETE /api/v1/email-rules/{rule}` |
| Read a window again with the rules in use | `POST /api/v1/connections/{id}/email-lab/reread` `{"since": "YYYY-MM-DD"}` |

Each email's `detection` says:

- `outcome`: `detected` (it gives a parcel, order or return), `ignored` (an `ignore` rule drops it:
  account and newsletter emails) or `not_detected`.
- `read_by`: `providers` (the email's sender domain belongs to a provider and passed the DKIM/DMARC
  check, so that provider's rules read it) or `shared_rules`.
- `providers`: the providers it was routed to.
- `rule_results`: what each rule that applied extracted (`rule_id`, tracking and order numbers,
  status, event). `schema.org` means embedded markup, `fallback` the format detection that runs
  when no rule applied.
- `parcels`, `orders`, `returns`: what the server would store.

### Writing a custom email rule

A rule is a JSON object in the email rule format of `open-parcels-rules`
(`schema/mail-rule.schema.json` in that package). The fields that matter most:

```json
{
  "id": "parcel-example-shop",
  "name": "Example shop shipping emails",
  "kind": "parcel",
  "senders": { "domains": ["shop.example.com"] },
  "subject": ["has shipped|ist unterwegs"],
  "carrier": "dhl",
  "extract": {
    "tracking_number": [
      { "pattern": "Tracking number:\\s*(?<tracking_number>[0-9]{12,20})", "in": ["text", "html"] }
    ],
    "order_number": [{ "pattern": "Order\\s+#?(?<order_number>[0-9]{6,})" }]
  },
  "default_status": "in_transit",
  "require": ["tracking_number"],
  "tests": [{ "fixture": "example-shop-shipped.eml", "expect": [] }]
}
```

- `id`: lower case, letters, digits, `_` and `-`; must not be a shared or provider rule's id. The
  part after `parcel-`, `order-` or `return-` names the shop of the order (`parcel-example-shop`
  files orders under the shop `example`).
- `kind`: `parcel`, `order`, `return`, `dunning` or `ignore`.
- `senders`: `addresses` (exact) and/or `domains` (a domain matches its subdomains too).
- `subject`, `body`, `exclude`: regular expressions (case-insensitive by default, `flags`).
- `extract`: per field, patterns with a named group of the field's name; `in` picks `subject`,
  `text` (the text part, or the HTML as text) or `html`.
- `extractors: ["detect_tracking_numbers"]` finds tracking numbers by their known formats.
- `status_keywords` / `event_keywords`: patterns that set the parcel status or the order event.
- `tests` is required by the schema; the server does not run it (a fixture name is enough).

## Playbook: an email is not detected

1. **Find the inbox.** `GET /api/v1/connections` and pick the entry with `kind: "mail"`. Check
   `state` is `ok`; `needs_sign_in` or `error` means the inbox itself is broken (ask the owner).
2. **Find the email.** List the folder around the day it arrived:
   `GET /api/v1/connections/{id}/email-lab/messages?folder=INBOX&since=2026-11-20&before=2026-11-22`.
   Match it by date, sender and subject; note its `uid` and `detection.outcome`.
3. **Read it.** `GET /api/v1/connections/{id}/email-lab/messages/{uid}?folder=INBOX`. Look at
   `from`, `subject`, `text` and `html_text` for the tracking number and order number, and at
   `detection`:
   - `ignored`: an `ignore` rule matched (account or newsletter rules). A custom rule cannot
     override it; report it to the owner.
   - `read_by: "providers"` with nothing found: the provider's rules do not know this email; a
     custom rule for the same sender is added to the provider's rules.
   - `not_detected` with `read_by: "shared_rules"`: no rule applied, or one applied but found
     nothing (see `rule_results`).
   - A sender domain that belongs to a provider but `providers` is empty: the DKIM/DMARC check
     failed. If the owner's mail server adds no `Authentication-Results` header, the inbox setting
     "Check senders (DKIM/DMARC)" can be turned off; that is the owner's decision.
4. **Write a candidate rule** for the sender and subject (see above) and test it on the email:

   ```sh
   curl -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
     "$OP/api/v1/email-lab/test" \
     -d '{"connection_id": "<inbox id>", "folder": "INBOX", "uid": 1234, "rules": [ <rule> ]}'
   ```

   `problems` lists schema errors per rule (fix and retry); `result` is how the email reads with
   the candidate, `baseline` how it reads now. An `.eml` file can be tested without an inbox:
   send its content as `raw` instead of `connection_id` and `uid`.
5. **Check it does not over-match.** Test the candidate on two or three other emails of the same
   sender (newsletters, order confirmations) and make sure they give nothing or the right kind.
6. **Save it.** `PUT /api/v1/email-rules/{id}` with the rule as the body. It applies to every new
   email at once.
7. **Read the missed emails again.**
   `POST /api/v1/connections/{id}/email-lab/reread` with `{"since": "2026-11-20", "before":
   "2026-11-22"}` (keep the window small). It only adds: nothing stored is removed and an email
   read twice adds no second history entry. Then `GET /api/v1/parcels` to confirm the parcel.
8. **Tell the owner** what you changed. A rule that would help other people (a shop or carrier
   anyone may get emails from) belongs upstream in the `open-parcels-rules` project, with a
   made-up `.eml` fixture; suggest that instead of keeping it only here.

## Safety rules

- **Carriers and shops are real services.** The server paces every request with conservative
  limits and backs off on errors. Do not work around that: do not call
  `POST /api/v1/connections/{id}/sync` in a loop, do not add the same tracking number again and
  again, and wait out a `429` and its `Retry-After`. One sync after a change is enough; parcels
  are polled on their own schedule.
- **Never trigger sign-ins** to "fix" a network error. A connection in `needs_sign_in` needs the
  owner.
- **Do not clear data** (`POST /api/v1/connections/{id}/clear`, `POST /api/v1/data/clear`) unless
  the owner asked for exactly that; the email lab's re-read covers missed emails without it.
- **Keep the re-read window small** and read a folder's pages, not the whole mailbox.
- **Personal data stays private.** Emails, names, addresses and tracking numbers are the owner's.
  Do not paste them into issues or public rules; use made-up values in fixtures.
- **Ask before changing settings**, connections or tokens.
