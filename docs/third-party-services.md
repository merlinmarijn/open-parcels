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
written permission; that is why the providers follow strict care rules (see `AGENT.md`): only the
parcels and accounts you add are asked about, on your own credentials, and providers that send a
browser-like User-Agent declare it, with the reason, in their provider information.

If a carrier objects or changes its terms, disable that connection; nothing else depends on it.

### How every provider is paced (reviewed 2026-11-25)

The rules below live in the server, not in each provider, so no provider can opt out of them.
Providers reach the network only through the provider HTTP client (ESLint refuses any other
import), and the code paths that apply them are `server/src/provider/http.ts`,
`server/src/engine/policy.ts` and `server/src/engine/scheduler.ts`.

- **Per-host token bucket.** Every request, including each hop of a redirect, waits for its host's
  bucket. The bucket is shared by every connection that reaches that host, so two accounts at one
  carrier share one pace. A provider declares its pace per host (table below); a host it does not
  list gets its `*` pace.
- **When a host asks to slow down** (HTTP 429, or 503 with `Retry-After`), that host gets nothing
  more from any connection until the pause is over: the time `Retry-After` names (seconds or a
  date), at least 60 s and at most 24 h. Requests meanwhile fail at once without being sent. The run
  that met the limit stops, and its connection waits 60 s × 2ⁿ (up to 1 h) or the `Retry-After`,
  whichever is longer (at most 24 h); `Retry-After: 0` never brings a run forward. While the carrier's
  own wait runs, "Sync now" answers 429 `connection_backing_off` instead of asking again.
- **Other failures** (network errors, timeouts, 5xx, unexpected pages) retry after 5 min × 2ⁿ, at
  most 45 min. A captcha pauses the connection for 6 h and is never solved. A refused sign-in stops
  the connection until you sign in again; a network error never starts a new sign-in.
- **Runs** are one at a time per connection and at most three connections at once. Tracking
  connections ask about their codes one after another, and the first rate limit, refusal or odd
  answer stops the run before more requests go out (`trackEach`). Optional extra lookups (event
  details, pickup point names, wording tables) give up on network trouble for that parcel only and
  still stop at a rate limit.
- **Polling:** every 15 min for parcels out for delivery within an hour of their expected delivery,
  every 45 min otherwise, every 3 h for accounts and shops with nothing in flight; tracking
  connections with nothing to track stop. Nothing is polled 00:00–06:00 local time
  (`OPENPARCELS_QUIET_WINDOW`), and each install and connection is shifted by its own 0–6 minutes.
- **Live courier maps** are read every 30 s only while a map session is open, probed every 5 min for
  parcels out for delivery, and stop after three failed passes until the next full poll.
- **Inboxes** (IMAP) reconnect after 30 s × 2ⁿ, at most 15 min; the wait resets only after a whole
  sync, so a server that drops every connection straight away is not asked again every 30 s.
- **Fallback services** are paced as the README describes (universal lookup: each code at most every
  3 h, 20 a run; 17TRACK: within your quota).
- **Caps per run:** Amazon loads at most 8 shipments' tracking pages and only the first orders page;
  account lists stop at a fixed page cap (Canada Post, Pošta Slovenije 20 pages, Mondial Relay,
  Posten/Bring 25, InPost Italy 10) instead of following a list that never ends.

Pace each provider declares (requests to one host; "burst 2" lets two go back to back before the
pace applies):

| Provider | Pacing per host (`*`: any other host it may reach) |
| :--- | :--- |
| 17TRACK | `api.17track.net` 1 per 2 s, burst 2; `*` 1 per 10 s |
| 4PX | `track.4px.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| ACS Courier | `api.acscourier.net` 1 per 5 s, burst 2; `www.acscourier.net` 1 per 60 s; `*` 1 per 10 s |
| Airmee | `api.airmee.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Amazon | `*` 1 per 5 s |
| Amazon Shipping | `track.amazon.com` 1 per 6 s, burst 2; `track.amazon.co.uk` 1 per 6 s, burst 2; `track.amazon.fr` 1 per 6 s, burst 2; `track.amazon.it` 1 per 6 s, burst 2; `track.amazon.es` 1 per 6 s, burst 2; `*` 1 per 10 s |
| Ampère | `bol.prd.amperebezorgt.nl` 1 per 5 s, burst 2; `link.bol.com` 1 per 10 s; `*` 1 per 10 s |
| An Post | `identity.anpost.com` 1 per 10 s, burst 2; `apim-anpost-mydeliveries.anpost.com` 1 per 10 s; `*` 1 per 10 s |
| Apple Express | `trackapi.appleexpress.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Aramex | `www.aramex.com.au` 1 per 5 s, burst 2; `www.aramex.co.nz` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Better Trucks | `tracking.bettertrucks.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| BOX NOW | `api-production.boxnow.gr` 1 per 5 s, burst 2; `api-production.boxnow.bg` 1 per 5 s, burst 2; `api-production.boxnow.hr` 1 per 5 s, burst 2; `api-production.boxnow.cy` 1 per 5 s, burst 2; `*` 1 per 10 s |
| bpost | `track.bpost.cloud` 1 per 5 s, burst 2; `mybpost.bpost.cloud` 1 per 5 s, burst 2; `*` 1 per 10 s |
| BRT | `login.dpdgroup.com` 1 per 30 s; `www.dpdgroup.com` 1 per 4 s, burst 2; `*` 1 per 10 s |
| Budbee | `tracking.budbee.com` 1 per 4 s, burst 2; `*` 1 per 10 s |
| Cainiao | `global.cainiao.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Canada Post | `www.canadapost-postescanada.ca` 1 per 4 s, burst 2; `sso-osu.canadapost-postescanada.ca` 1 per 30 s; `b3n4knmt6famlj575e5pfn74lm.appsync-api.ca-central-1.amazonaws.com` 1 per 10 s, burst 2; `*` 1 per 10 s |
| Canpar Express | `canship.canpar.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Cargus | `cmacwabackend.azurewebsites.net` 1 per 5 s, burst 2; `mycargus.b2clogin.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| CDL Last Mile | `apps.cdldelivers.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Colis Privé | `colisprive.com` 1 per 6 s, burst 2; `*` 1 per 10 s |
| Colisweb | `www.colisweb.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Correos | `localizador.correos.es` 1 per 5 s, burst 2; `*` 1 per 10 s |
| CTT | `appserver.ctt.pt` 1 per 5 s, burst 3; `wct.cttexpress.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| DAO | `apiv2.dao.as` 1 per 4 s, burst 2; `auth.dao.as` 1 per 10 s, burst 2; `*` 1 per 10 s |
| Delhivery | `dlv-api.delhivery.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| DHL | `api-gw.dhlparcel.nl` 1 per 6 s, burst 2; `api-eu.dhl.com` 1 per 6 s; `login.dhl.de` 1 per 5 s, burst 2; `www.dhl.de` 1 per 6 s, burst 2; `my.dhlecommerce.nl` 1 per 6 s, burst 2; `clientesparcel.dhl.es` 1 per 6 s, burst 2; `hamta.dhl.com` 1 per 6 s, burst 2; `mojdhl.pl` 1 per 8 s, burst 2; `*` 1 per 10 s |
| DPD | `tracking.dpd.de` 1 per 3 s, burst 2; `www.dpd.com` 1 per 4 s, burst 2; `portal.dpd.de` 1 per 4 s, burst 2; `my.dpd.de` 1 per 4 s, burst 2; `*` 1 per 4 s, burst 2 |
| Dragonfly | `dragonflyshipping.nl` 1 per 5 s, burst 2; `dragonflyshipping.com.au` 1 per 5 s, burst 2; `intelcom.ca` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Dynalogic | `api.dynagroup.nl` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Early Bird | `earlybird.se` 1 per 6 s, burst 2; `*` 1 per 10 s |
| Econt | `ee.econt.com` 1 per 6 s, burst 2; `*` 1 per 10 s |
| Ecoscooting | `de-link.cainiao.com` 1 per 6 s, burst 2; `*` 1 per 10 s |
| ELTA Courier | `www.elta-courier.gr` 1 per 6 s, burst 2; `*` 1 per 10 s |
| Evri | `tracking.platform-apis.evri.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| FAN Courier | `www.fancourier.ro` 1 per 6 s, burst 2; `*` 1 per 10 s |
| FedEx | `apis.fedex.com` 1 per 3 s, burst 3; `*` 1 per 10 s |
| Geniki Taxydromiki | `taxydromiki.com` 1 per 6 s; `*` 1 per 10 s |
| GLS | `apm.gls.nl` 1 per 5 s, burst 2; `gls-group.com` 1 per 5 s, burst 2; `gls-group.eu` 1 per 5 s, burst 2; `api-backend.glsnxt.com` 1 per 30 s; `gls-pakete-de-backend-app.ooh.glsnxt.com` 1 per 5 s, burst 2; `api.consignee.gls-spain.es` 1 per 5 s, burst 2; `mygls.gls-poland.com.pl` 1 per 5 s, burst 2; `connect.gls-us.com` 1 per 5 s, burst 2; `web.gls-canada.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| GoBolt | `api.secondcloset.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| GOFO Express | `www.gofo.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Helthjem | `services.helthjem.no` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Hermes | `api.my-deliveries.de` 1 per 4 s, burst 2; `mobile-app-api.a0930.prd.hc.de` 1 per 10 s, burst 2; `*` 1 per 10 s |
| Hrvatska pošta | `posiljka.posta.hr` 1 per 6 s, burst 2; `*` 1 per 10 s |
| ICS Courier | `www1.icscourier.ca` 1 per 5 s, burst 2; `*` 1 per 10 s |
| InPost | `inposteasy.com` 1 per 5 s, burst 2; `api-inmobile-pl.easypack24.net` 1 per 10 s, burst 2; `account.inpost-group.com` 1 per 10 s; `*` 1 per 10 s |
| La Poste (Colissimo, Chronopost) | `www.laposte.fr` 1 per 6 s, burst 2; `*` 1 per 10 s |
| Magyar Posta | `posta.hu` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Matkahuolto | `wwwservice.matkahuolto.fi` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Mondial Relay | `www.mondialrelay.be` 1 per 5 s, burst 2; `account.inpost-group.com` 1 per 10 s, burst 2; `mobile-app-bff.mondialrelay.app` 1 per 4 s, burst 2; `*` 1 per 10 s |
| Nova Post | `api.novaposhta.ua` 1 per 4 s, burst 2; `*` 1 per 10 s |
| NZ Post | `tools.nzpost.co.nz` 1 per 5 s, burst 2; `*` 1 per 10 s |
| OnTrac | `webtrack.ontrac.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| ORLEN Paczka | `nadaj.orlenpaczka.pl` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Paack | `paack.co` 1 per 6 s; `*` 1 per 10 s |
| Packeta (Zásilkovna) | `tracking.packeta.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| PDN Express | `pdn.express` 1 per 4 s, burst 2; `*` 1 per 10 s |
| Planzer | `api.tracking.app.planzer.ch` 1 per 4 s, burst 2; `*` 1 per 10 s |
| Poczta Polska | `uss.poczta-polska.pl` 1 per 4 s, burst 2; `emonitoring.poczta-polska.pl` 1 per 30 s; `*` 1 per 10 s |
| Poste Italiane | `www.poste.it` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Posten / Bring | `api.posten.no` 1 per 5 s, burst 2; `id.posten.no` 1 per 10 s, burst 2; `login.bring.com` 1 per 10 s, burst 2; `*` 1 per 10 s |
| Posti | `graphql.posti.fi` 1 per 4 s, burst 2; `auth-service.posti.fi` 1 per 15 s, burst 4; `mfa.posti.fi` 1 per 5 s, burst 3; `todentaminen.posti.fi` 1 per 3 s, burst 3; `*` 1 per 10 s |
| PostNL | `jouw.postnl.nl` 1 per 4 s, burst 2; `login.postnl.nl` 1 per 30 s, burst 2; `*` 1 per 10 s |
| PostNord | `api2.postnord.com` 1 per 4 s, burst 2; `account.postnord.com` 1 per 10 s, burst 2; `*` 1 per 10 s |
| Pošta Slovenije | `moja.posta.si` 1 per 4 s, burst 2; `auth.posta.si` 1 per 30 s, burst 2; `*` 1 per 10 s |
| Pošta Srbije | `api.posta.rs` 1 per 6 s, burst 2; `*` 1 per 10 s |
| PPL CZ | `api.dhl.com` 1 per 4 s, burst 2; `pplczmobidentity.b2clogin.com` 1 per 10 s, burst 2; `*` 1 per 10 s |
| Purolator | `public-tracking.purolator.com` 1 per 10 s; `*` 1 per 10 s |
| Quickpac | `parcelsearch.quickpac.ch` 1 per 4 s, burst 2; `*` 1 per 10 s |
| Sameday | `api.sameday.ro` 1 per 5 s, burst 2; `api.sameday.hu` 1 per 5 s, burst 2; `api.sameday.bg` 1 per 5 s, burst 2; `*` 1 per 10 s |
| SEUR | `sso.seur.com` 1 per 30 s; `www.seur.com` 1 per 10 s, burst 2; `*` 1 per 10 s |
| Shopee Xpress | `spx.com.br` 1 per 6 s, burst 2; `spx.co.id` 1 per 6 s, burst 2; `spx.com.my` 1 per 6 s, burst 2; `spx.ph` 1 per 6 s, burst 2; `spx.co.th` 1 per 6 s, burst 2; `spx.vn` 1 per 6 s, burst 2; `*` 1 per 10 s |
| Slovak Parcel Service | `rest.mysps.sk` 1 per 6 s, burst 2; `*` 1 per 10 s |
| Slovenská pošta | `api.posta.sk` 1 per 10 s; `*` 1 per 10 s |
| Spee-Dee Delivery | `packages.speedeedelivery.com` 1 per 10 s; `*` 1 per 10 s |
| SpeedX | `tracking.speedx.io` 1 per 8 s, burst 2; `*` 1 per 10 s |
| Straightship | `straightship.com` 1 per 10 s; `*` 1 per 10 s |
| SunYou | `www.sypost.net` 1 per 6 s, burst 2; `*` 1 per 10 s |
| Swiss Post | `service.post.ch` 1 per 4 s, burst 3; `login.swissid.ch` 1 per 10 s, burst 2; `app.post.ch` 1 per 5 s, burst 2; `*` 1 per 10 s |
| TIPSA | `aplicaciones.tip-sa.com` 1 per 8 s; `dinapaqweb.tipsa-dinapaq.com` 1 per 8 s; `*` 1 per 10 s |
| Trunkrs | `api.trunkrs.app` 1 per 6 s, burst 2; `*` 1 per 10 s |
| Ukrposhta | `www.ukrposhta.ua` 1 per 5 s, burst 2; `*` 1 per 10 s |
| UniUni | `delivery-api.uniuni.ca` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Universal lookup | `*` 1 per 5 s |
| UPS | `webapis.ups.com` 1 per 5 s; `onlinetools.ups.com` 1 per 2 s, burst 2; `*` 1 per 10 s |
| USPS | `apis.usps.com` 1 per 4 s, burst 2; `apis-id.usps.com` 1 per 6 s, burst 2; `verified.usps.com` 1 per 3 s, burst 3; `*` 1 per 10 s |
| Vinted Go | `carrier.vintedgo.com` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Österreichische Post | `api.post.at` 1 per 5 s, burst 2; `*` 1 per 10 s |
| Česká pošta | `b2c.cpost.cz` 1 per 5 s, burst 2; `www.balikovna.cz` 1 per 5 s, burst 2; `*` 1 per 10 s |
