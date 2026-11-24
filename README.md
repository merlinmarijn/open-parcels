<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/open-parcels/open-parcels/main/docs/branding/banner-on-dark.png">
    <img alt="Open Parcels" src="https://raw.githubusercontent.com/open-parcels/open-parcels/main/docs/branding/banner-on-light.png" width="640">
  </picture>
</p>
<p align="center">
  <a href="https://hub.docker.com/r/bluscream1/open-parcels"><img alt="Docker Hub pulls" src="https://img.shields.io/docker/pulls/bluscream1/open-parcels?logo=docker&label=pulls"></a>
  <a href="https://github.com/open-parcels/open-parcels/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/open-parcels/open-parcels?include_prereleases&sort=semver"></a>
  <a href="https://github.com/open-parcels/open-parcels/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/open-parcels/open-parcels?style=flat"></a>
  <a href="https://github.com/open-parcels/open-parcels/issues"><img alt="Open issues" src="https://img.shields.io/github/issues/open-parcels/open-parcels"></a>
  <a href="https://github.com/open-parcels/open-parcels/commits"><img alt="Last commit" src="https://img.shields.io/github/last-commit/open-parcels/open-parcels"></a>
</p>

# Open Parcels

**Self-hosted parcel and order tracking.** One service on your own hardware follows about 95
carriers, signs in to carrier and shop accounts, reads shipping emails, shows the courier live on a
map and keeps a delivery calendar (also as an ICS feed).

> **Status:** early development, `2.0.0-dev`. Expect breaking changes.

This repository holds the server and the web UI: carrier providers, email parsing, the scheduler,
the REST API with its event stream, the Docker image and the Unraid template.

- Website, install guides and the carrier list: <https://open-parcels.github.io>
- Home Assistant integration: [open-parcels-ha](https://github.com/open-parcels/open-parcels-ha)
- Home Assistant app (runs the server inside Home Assistant, in the sidebar): [open-parcels-ha-apps](https://github.com/open-parcels/open-parcels-ha-apps)
- Shared carrier and email rules: [open-parcels-rules](https://github.com/open-parcels/open-parcels-rules)
- Browser extension for app-only carrier sign-ins: [open-parcels-extension](https://github.com/open-parcels/open-parcels-extension)

## Quick start

```sh
docker compose up -d   # uses docker-compose.yml from this repository
```

Then open <http://localhost:3000> and finish the setup with the code from `docker compose logs open-parcels`. The website has guides for Unraid and Home Assistant. For something to look at before
you add real accounts, add the **Demo shop** and **Demo courier** connections: three made-up parcels
in two orders, with a live courier on the map.

## Access

Two passwords, both optional settings (environment, or **Settings → Security**):

| Setting | Allows | Unset |
| :--- | :--- | :--- |
| `OPENPARCELS_PASSWORD` | Reading: the web UI, the API, live updates, maps, images. | Anyone who can reach the server reads everything. |
| `OPENPARCELS_ADMIN_PASSWORD` | Everything that changes something (every non-GET request): connections, sign-ins, sync, parcel and order edits, settings, tokens. | First start prints a setup code to the log; entering it in the web UI chooses the admin password. |

The admin password may also be changed in the UI (it needs the current one). It is then stored
scrypt-hashed and wins over the environment until **Reset to environment**; changing or resetting
it logs every session out. Changing the reader password logs readers out. Home Assistant ingress
counts as the admin. API tokens keep their scopes: `read` reads, `write` or `admin` may change
things, and only `admin` manages tokens and server settings.

**Upgrading** from a version with a single owner password: nothing to do. The owner password
becomes the admin password (still hashed, shown as "saved in UI"), open sessions stay logged in as
admin, and reading is open until `OPENPARCELS_PASSWORD` is set. To keep reading private as before,
set `OPENPARCELS_PASSWORD` (or set it on the Security card right after upgrading).

## Privacy

Open Parcels talks to the carriers and shops you add (and the hosts of their item pictures), and
otherwise only to these:

- **Place lookups** (`OPENPARCELS_GEOCODING`, on by default): carrier events that name only a place
  ("Leipzig hub") are looked up on [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org),
  so they can show on the map. Only those place names are sent, at most five a minute, and each
  answer is cached. Turn the setting off (**Settings → Map**, admin only) to keep them on this server.
- **Map tiles** are fetched by the server from the map provider you choose and cached.

## Fallback services

Two optional connections ask about parcels the built-in carriers cannot follow: a code no carrier
recognises, a carrier without a provider (or whose provider needs settings you have not given),
or a parcel its carrier has not found for a day. Both are off until you add them under
**Connections**, and both may exist side by side:

| Service | What you enter | Notes |
| :--- | :--- | :--- |
| **Universal lookup** | The address of a universal-lookup service (`GET <url>/api/parcel/<tracking number>`), e.g. one you host yourself | Each code is asked at most every 3 hours, one request every 5 seconds, at most 20 codes a run. The address must be reachable on a public address (the server refuses private network addresses). |
| **17TRACK** | Your own API key of the [17TRACK tracking API](https://api.17track.net) (v2.2) | Each number is registered once (that uses one unit of your quota) and then read at most every 6 hours. The quota is checked before registering (at most every 12 hours), today's cap is respected, and registering pauses for 12 hours once the quota is used up; parcels waiting for a registration keep their state. |

They are asked one at a time: the universal lookup first, 17TRACK only when the one before has
not found the parcel for a day either. Their answers are filed under the parcel's own carrier, so
no second parcel appears, and once a parcel is handed to a fallback service, its answers decide
whether the parcel counts as found. A code no carrier recognises can be added by hand while a
fallback service exists; it is then filed under that service. Both services see the tracking
numbers they are asked about, and nothing else.

## Tailscale (built in)

The image can join your tailnet itself, so no sidecar container is needed. Set `TS_STATE_DIR`
(for example `/var/lib/tailscale`) and mount a persistent folder there, writable for uid 1000.
On the first start also set `TS_AUTHKEY`; later starts reuse the saved state. The web UI is then
served at `https://<TS_HOSTNAME>.<your-tailnet>.ts.net` (`TS_HOSTNAME` defaults to `open-parcels`).
Tailscale runs in userspace mode, as the same unprivileged user, so the container needs no extra
capabilities and no `/dev/net/tun`. Without `TS_STATE_DIR` the image behaves as before.
Tailnet visitors reach the app through `tailscale serve` on 127.0.0.1, so the image then sets
`OPENPARCELS_TRUST_PROXY=127.0.0.1` itself (unless you set it), and the login throttle sees each
visitor's own address.
Set `OPENPARCELS_PUBLIC_URL` to the tailnet address so links point there.

## Development

```sh
npm install
npm run gate   # format check, lint, type check, tests, build
```

API reference: [`docs/openapi.json`](docs/openapi.json). Branding assets: [`docs/branding`](docs/branding).

## License

Released into the public domain under [The Unlicense](LICENSE).