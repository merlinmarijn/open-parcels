# Third-party services

Besides the carriers and shops you add, Open Parcels talks to the services below. All requests go
from the server; browsers never contact them directly. Every request carries the same
User-Agent, `open-parcels/2.0 (self-hosted parcel tracker; +https://github.com/open-parcels/open-parcels)`,
with the address from `OPENPARCELS_CONTACT_EMAIL` added inside the parentheses when you set one,
so an operator can write to you instead of blocking your install.

Terms were last checked on **2026-11-25**. They can change; read the linked pages before you rely
on a service for anything beyond a household install.

## OpenStreetMap tiles (map layer "Map", the default)

- **What is sent:** requests for the map tiles a map on screen shows (zoom, x, y). Nothing about
  parcels, and not your browser's address or Referer.
- **Terms:** [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
  Visible "© OpenStreetMap contributors" credit (shown on every map, with a "Report a map issue"
  link to [openstreetmap.org/fixthemap](https://www.openstreetmap.org/fixthemap)); a stable,
  identifying User-Agent; honour the caching headers, keeping tiles at least 7 days when they say
  nothing, and refresh with conditional requests; no prefetching, offline packs or bulk downloads;
  the tile address must be changeable without a software update. Service is best effort and heavy
  use may be blocked.
- **How Open Parcels complies:** tiles are fetched only on demand, at most two at a time, cached on
  disk for as long as `Cache-Control` / `Expires` allow (a week when absent) and refreshed with
  `If-None-Match` / `If-Modified-Since` (a `304` keeps the cached copy).
- **Switching:** set `OPENPARCELS_MAP_OSM_URL` (or **Settings → Map**) to another tile template,
  for example your own tile server, or choose another layer with `OPENPARCELS_MAP_BASE_LAYER` or
  the custom provider (`OPENPARCELS_MAP_CUSTOM_URL`).

## OpenTopoMap (layer "Topographic")

- **What is sent:** tile requests, as above.
- **Terms:** [opentopomap.org/about](https://opentopomap.org/about): map style CC-BY-SA, credit
  "Map data: © OpenStreetMap contributors, SRTM | Map display: © OpenTopoMap (CC-BY-SA)" (shown on
  the map; the German original is "Kartendaten: © OpenStreetMap-Mitwirkende, SRTM |
  Kartendarstellung: © OpenTopoMap (CC-BY-SA)"); no mass downloads; no guarantee of availability.
- **Switching:** `OPENPARCELS_MAP_TOPO_URL` takes another tile template (for example a mirror).

## EOX Sentinel-2 cloudless and overlays (layers "Satellite", "Borders only", "Borders & labels")

- **What is sent:** tile requests, as above.
- **Terms:** [cloudless.eox.at](https://cloudless.eox.at): the imagery is licensed
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), so **non-commercial use
  only** unless you hold a commercial licence from EOX. The layer picker labels the satellite layer
  that way. Credit "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains
  modified Copernicus Sentinel data &lt;year&gt;)" with the year of the imagery served; the server
  takes the year and the tile address from one constant (`EOX_CLOUDLESS_YEAR` in
  `server/src/tiles/layers.ts`), so the credit always matches. The overlays carry the
  OpenStreetMap credit and EOX's.
- **Switching:** `OPENPARCELS_MAP_EOX_URL` replaces the WMTS base address for all three layers.

## Place search (Nominatim)

- **What is sent:** the text you search for on **Settings → Home location** (only when you press
  *Find*; there is no search-as-you-type), and, only if you turn on the background place lookup
  (`OPENPARCELS_GEOCODING`), the place names carrier scans contain ("Leipzig hub"), never tracking
  numbers, names or addresses of yours.
- **Terms:** [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/):
  at most one request per second for the whole application, an identifying User-Agent, cache the
  results, credit OpenStreetMap (ODbL) where results are shown, no autocomplete, and periodic or
  automatic requests count as bulk use and are strongly discouraged. A widely distributed app
  should not rely on the public server by default and must be able to switch service without a
  software update.
- **How Open Parcels complies:** one request per second across the server, answers cached, the
  OSM/ODbL credit under the address search, and the background lookup is **off by default** for
  new installs. Installs that ran with the old default keep it on (see the changelog); turn it off
  on **Settings → Map**.
- **Switching:** `OPENPARCELS_GEOCODING_URL` takes the search endpoint of any Nominatim-compatible
  service (`…/search?q=…&format=jsonv2`), for example your own
  [Nominatim](https://nominatim.org) instance. Use one of your own before turning on the background
  lookup for many parcels.

## Optional services you add yourself

CARTO basemaps (`OPENPARCELS_MAP_CARTO_KEY`), a custom tile provider and the fallback tracking
services (universal lookup, 17TRACK; see the README) are used only after you configure them, under
that provider's terms and with your own key.

## Carrier and shop endpoints

Carrier and shop connections read the same tracking and account pages their apps and websites use.
Most of these endpoints are not offered as a public API and none was used with the carrier's
written permission; that is why the providers follow strict care rules (see `AGENT.md`):

- conservative rate limits per host, generous delays and backoff, honouring `Retry-After`;
- many failsafes: stop fast when a response looks wrong, and never start a new sign-in because of
  a network error;
- only the parcels and accounts you add are asked about, on your own credentials;
- providers that send a browser-like User-Agent declare it, with the reason, in their provider
  information.

If a carrier objects or changes its terms, disable that connection; nothing else depends on it.
