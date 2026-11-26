# Provider manifests and the sandbox

Design note for TODO §3 "Manifest format and capabilities model" and "Provider sandbox". It
narrows decision record [0002](decisions/0002-providers.md) (§2.2, §2.3, §2.7, §3.1 steps 1–3) to
what is built now, and says how consumers ([0005](decisions/0005-consumers.md)) reuse it.

## 1. The manifest (format 1)

Every provider has one manifest, `open-parcels-provider.json`, at the root of its folder. Built-in
providers keep theirs in `server/src/carriers/<id>/`; one folder is one provider (the demo shop
moves to its own folder). The schema is `server/src/provider/manifest.ts` (zod), the only parser.
Installed providers (P3) bring the same document; YAML is only another spelling of it and is
parsed into the same schema then. The schema moves to the engine package with the split (P5).

```json
{
  "schema": 1,
  "id": "hermes",
  "name": "Hermes",
  "countries": ["DE"],
  "aliases": ["myHermes"],
  "logo": "hermes.svg",
  "provides": { "connections": ["account", "tracking"], "live": false, "fallback": false },
  "permissions": {
    "network": [
      { "host": ".my-deliveries.de", "reason": "Public tracking API and myHermes account." }
    ],
    "image_hosts": [],
    "secrets": ["credentials"],
    "session": true,
    "user_agent": false
  }
}
```

- **The manifest is the one source of what a provider is and may do.** Name, countries,
  aliases, logo, connection kinds and image hosts leave the code (`defineCarrier`); the code keeps
  behaviour only (schemas, sign-in flows, pacing in `http.limits`, `fetchAccount`/`track`/
  `readLive`).
- **No `version` yet:** a built-in provider is versioned by the image it ships in. `version`,
  `engine` and `entry` come with installs (P3), as additions to format 1.
- **Capabilities** (`provides`): the connection kinds (`account`, `tracking`, `shop`), `live`
  (courier map) and `fallback` (a fallback service). Data capabilities (status tables, email
  rules, tracking-number patterns), `mail` and `actions` are added to `provides` by the phases that
  build them (P2b, P2c, P5); format 1 refuses unknown keys, so a manifest cannot claim them early.
- **Permissions:**
  - `network`: every host the provider may reach, each with a reason. `host` is exact
    (`api.example.com`) or a leading-dot suffix (`.example.com`: the domain and its subdomains).
    `{ "config": "<field>", "reason": … }` allows the host of a URL the user typed into that
    config field (the universal lookup's server). There is no `*`.
  - `image_hosts`: what the image proxy may fetch for this provider (as today's `imageHosts`).
  - `secrets`: the secret kinds its sign-in flows produce: `credentials`, `api_key`, `token`
    (interactive).
  - `session`: whether it keeps a per-connection session store.
  - `user_agent`: whether it overrides the honest User-Agent (the reason stays next to the value
    in the code).
- **Checked at registration** (start-up fails, and a test registers every built-in): the
  manifest parses; its `id` equals the code's; `provides.connections` covers exactly the kinds the
  code implements (`account`/`shop` need `fetchAccount`, `tracking` needs `track`); `live` iff
  `readLive`; `secrets` equals what the sign-in flows produce; `user_agent` iff the code sets one;
  every host in `http.limits` is covered by `network`; the logo exists.
- **Enforced at run time:** `ProviderHttp` refuses any request, and any redirect hop, to a host
  the manifest does not list (`HostNotAllowedError`: not a transient error, so the run is logged
  as a bug, and never a sign-in problem). A session store of a provider without `session` refuses
  to save. The image proxy takes its hosts from the manifests.

## 2. The sandbox

A generic host for untrusted modules, `server/src/sandbox/`, that knows nothing about carriers.
Providers are its first user; consumers its second.

- **Process:** `child_process.fork` of `sandbox/child.js` with
  `--permission --allow-fs-read=<the runtime's files>,<the package folder>` (no write, no network,
  no child processes, no workers, no addons, no WASI), `--max-old-space-size`, and
  `--disallow-code-generation-from-strings`. The core refuses to start a sandbox on a Node release
  without the permission model's network flag.
- **Protocol** (IPC, structured clone): the host sends `call {id, method, args}`; the child answers
  `result {id, value}` or `error {id, error}`; while a call runs the child may send
  `request {id, call, capability, args}` and the host answers `reply {id, value | error}`. Errors
  cross as `{name, message, retryAfter?}` and are rebuilt into the provider API's error classes,
  so the runner's classification does not change.
- **Broker:** each call carries its own capability handlers on the host side. A request for a
  capability the call did not grant is refused. Nothing is ambient: no handler outlives its call.
- **Secrets per call:** config, secret and session travel with the call that needs them; the
  child holds no store. Its memory only ever holds connections of the provider(s) it hosts.
- **HTTP:** `ProviderHttp` is split into the client (redirect loop, cookie jar, `allowRedirect`,
  decoding; runs where the provider runs) and the hop transport (allow-list, non-public address
  check, host token buckets, pauses, User-Agent, body cap; always in the core). In the sandbox the
  client sends each hop over IPC, so the allow-list is checked by the core for every hop and the
  child never holds a socket.
- **Limits:** a timeout per call (kill and restart the child, the call fails as transient), and
  three crashes in ten minutes disable the sandbox until it is started again.
- **Providers in it:** a provider adapter serves `fetchAccount`, `track`, `readLive` and sign-in
  turns from the child. `OPENPARCELS_PROVIDER_ISOLATION=off|pool` picks in-process or one pool
  process for the built-ins; the default stays `off` until the fixture suites pass in both modes.
- **Consumers (0005) reuse it unchanged:** a consumer module exports `deliver`/`test`, its manifest
  lists `network` hosts like a provider's, and its calls are brokered with `http` (and nothing
  else): the same process, protocol, allow-list and limits.
