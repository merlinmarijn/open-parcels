import { escapeHtml } from "../net/html.js";
import { createHash } from "node:crypto";
import type { Language } from "../i18n/language.js";
import { isNonPublicHostLiteral } from "../net/address.js";

/**
 * The map styles the server proxies. Providers whose terms allow keyless use by a personal,
 * self-hosted server that caches tiles are built in; CARTO is built in behind the owner's own
 * CARTO key; anything else (Esri, MapTiler, Stadia, Thunderforest, Mapbox) is reached through the
 * custom provider with the owner's own key.
 * Upstream URLs and keys never leave the server: the web only sees ids, labels and attribution.
 * Labels and attributions are kept per language; the layer list answers in the one asked for.
 */
type LayerKind = "base" | "overlay";
type TileFormat = "png" | "jpg";

/** A text in every language the server speaks. */
type Localized = Readonly<Record<Language, string>>;

const both = (text: string): Localized => ({ en: text, de: text });

export interface TileLayerDef {
  readonly id: string;
  readonly label: Localized;
  readonly kind: LayerKind;
  /** `{s}` subdomain, `{z}/{x}/{y}`, `{r}` retina suffix (always empty) and `{key}`. */
  readonly url: string;
  readonly subdomains?: readonly string[];
  readonly format: TileFormat;
  /** The deepest zoom the provider serves; the map scales its tiles up beyond it. */
  readonly maxZoom: number;
  /** HTML, shown in the map's attribution control. */
  readonly attribution: Localized;
  /** Photographic imagery: the dark-mode filter is not applied. */
  readonly satellite: boolean;
  /** A dark style already: the dark-mode filter would turn it light, so it is not applied. */
  readonly dark?: boolean;
  /** Folder under the tile cache; changes when the upstream does. */
  readonly cacheKey: string;
  /** Filled into `{key}`; never sent to the browser. */
  readonly apiKey?: string;
}

const OSM_LINK = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const OSM: Localized = { en: `${OSM_LINK} contributors`, de: `${OSM_LINK}-Mitwirkende` };
/** OpenStreetMap's tile policy recommends a way to report map errors next to the credit. */
const OSM_FIX: Localized = {
  en: '<a href="https://www.openstreetmap.org/fixthemap">Report a map issue</a>',
  de: '<a href="https://www.openstreetmap.org/fixthemap">Kartenfehler melden</a>',
};
/**
 * The year of the EOX Sentinel-2 cloudless mosaic served. The upstream URL, the cache folder and
 * the attribution all read it, so the credit always names the imagery actually shown.
 */
export const EOX_CLOUDLESS_YEAR = 2025;
const EOX_CLOUDLESS = '<a href="https://cloudless.eox.at">EOxCloudless</a>';
const CC_BY_NC_SA =
  '<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0</a>';
const EOX: Localized = {
  en: `${EOX_CLOUDLESS} by EOX IT Services GmbH (contains modified Copernicus Sentinel data ${String(EOX_CLOUDLESS_YEAR)}), ${CC_BY_NC_SA}`,
  de: `${EOX_CLOUDLESS} von EOX IT Services GmbH (enthält veränderte Copernicus-Sentinel-Daten ${String(EOX_CLOUDLESS_YEAR)}), ${CC_BY_NC_SA}`,
};
const EOX_LINK = '&copy; <a href="https://eox.at">EOX</a>';
const EOX_OVERLAY: Localized = {
  en: `${OSM.en}, rendering ${EOX_LINK}`,
  de: `${OSM.de}, Darstellung ${EOX_LINK}`,
};
const OPEN_TOPO_MAP =
  '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)';
const EOX_WMTS = "https://tiles.maps.eox.at/wmts/1.0.0";

export const BUILTIN_LAYERS: readonly TileLayerDef[] = [
  {
    id: "osm",
    label: { en: "Map", de: "Karte" },
    kind: "base",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    format: "png",
    maxZoom: 19,
    attribution: { en: `${OSM.en} | ${OSM_FIX.en}`, de: `${OSM.de} | ${OSM_FIX.de}` },
    satellite: false,
    cacheKey: "osm",
  },
  {
    id: "topo",
    label: { en: "Topographic", de: "Topografisch" },
    kind: "base",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c"],
    format: "png",
    maxZoom: 17,
    attribution: {
      en: `Map data: ${OSM.en}, SRTM | Map display: ${OPEN_TOPO_MAP}`,
      de: `Kartendaten: ${OSM.de}, SRTM | Kartendarstellung: ${OPEN_TOPO_MAP}`,
    },
    satellite: false,
    cacheKey: "topo",
  },
  {
    id: "satellite",
    // EOX licenses the mosaic for non-commercial use only (CC BY-NC-SA 4.0).
    label: {
      en: "Satellite (non-commercial use only)",
      de: "Satellit (nur nicht kommerzielle Nutzung)",
    },
    kind: "base",
    // WMTS REST order: TileMatrix/TileRow/TileCol, i.e. z/y/x.
    url: `${EOX_WMTS}/s2cloudless-${String(EOX_CLOUDLESS_YEAR)}_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg`,
    format: "jpg",
    // Sentinel-2 is 10 m imagery: deeper tiles are only upscaled copies.
    maxZoom: 15,
    attribution: EOX,
    satellite: true,
    cacheKey: `s2cloudless-${String(EOX_CLOUDLESS_YEAR)}`,
  },
  {
    id: "borders",
    label: { en: "Borders only", de: "Nur Grenzen" },
    kind: "base",
    url: `${EOX_WMTS}/overlay_bright_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.png`,
    format: "png",
    maxZoom: 18,
    attribution: EOX_OVERLAY,
    satellite: false,
    cacheKey: "eox-overlay-bright",
  },
  {
    id: "labels",
    label: { en: "Borders & labels", de: "Grenzen & Beschriftungen" },
    kind: "overlay",
    url: `${EOX_WMTS}/overlay_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.png`,
    format: "png",
    maxZoom: 18,
    attribution: EOX_OVERLAY,
    satellite: false,
    cacheKey: "eox-overlay",
  },
];

const CARTO_LINK = '&copy; <a href="https://carto.com/attributions">CARTO</a>';
const CARTO: Localized = { en: `${OSM.en} ${CARTO_LINK}`, de: `${OSM.de} ${CARTO_LINK}` };

/**
 * CARTO basemaps, offered once the owner has saved a CARTO API key (free for non-commercial use,
 * carto.com/basemaps/apikey); without one CARTO only serves "API key required" tiles. Dark Matter
 * is what open-parcels used before the rewrite.
 */
const CARTO_LAYERS: readonly TileLayerDef[] = (
  [
    [
      "carto_dark",
      { en: "Dark (CARTO Dark Matter)", de: "Dunkel (CARTO Dark Matter)" },
      "dark_all",
    ],
    ["carto_light", { en: "Light (CARTO Positron)", de: "Hell (CARTO Positron)" }, "light_all"],
    ["carto_voyager", both("Voyager (CARTO)"), "voyager"],
  ] as const
).map(([id, label, style]) => ({
  id,
  label,
  kind: "base" as const,
  url: `https://basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png?key={key}`,
  format: "png" as const,
  maxZoom: 20,
  attribution: CARTO,
  satellite: false,
  dark: style === "dark_all",
  cacheKey: `carto-${style}`,
}));

export const BASE_LAYER_CHOICES = [
  ...BUILTIN_LAYERS.filter((layer) => layer.kind === "base").map((layer) => layer.id),
  "carto_dark",
  "carto_light",
  "carto_voyager",
  "custom",
] as const;
export const OVERLAY_CHOICES = [
  "none",
  ...BUILTIN_LAYERS.filter((layer) => layer.kind === "overlay").map((layer) => layer.id),
] as const;

const PLACEHOLDER = /\{([^}]*)\}/g;
const KNOWN = new Set(["s", "z", "x", "y", "r", "key"]);

/** Why a custom URL template is unusable, or null when it is fine. */
export function templateProblem(template: string): string | null {
  const names = [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
  const unknown = names.find((name) => !KNOWN.has(name));
  if (unknown !== undefined) {
    return `Unknown placeholder {${unknown}}; use {s}, {z}, {x}, {y}, {r} and {key}.`;
  }
  if (!["z", "x", "y"].every((name) => names.includes(name))) {
    return "The template must contain {z}, {x} and {y}.";
  }
  let url: URL;
  try {
    url = new URL(template.replace(PLACEHOLDER, "a"));
  } catch {
    return "Not a URL.";
  }
  if (url.protocol !== "https:") return "Tile servers must be reached over https.";
  if (url.username !== "" || url.password !== "") return "Put credentials into {key}, not the URL.";
  if (isNonPublicHostLiteral(url.hostname)) return "Tile servers must have a public address.";
  return null;
}

export interface CustomProvider {
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly attribution: string | undefined;
  readonly maxZoom: number;
}

/** The custom provider as a layer; null when its template needs a key that is not set. */
export function customLayer(custom: CustomProvider): TileLayerDef | null {
  if (custom.url.includes("{key}") && custom.apiKey === undefined) return null;
  const hash = createHash("sha256").update(custom.url).digest("hex").slice(0, 12);
  const format: TileFormat = /\.jpe?g(\?|$)/i.test(custom.url) ? "jpg" : "png";
  return {
    id: "custom",
    label: { en: "Custom", de: "Eigener Anbieter" },
    kind: "base",
    url: custom.url,
    subdomains: ["a", "b", "c"],
    format,
    maxZoom: custom.maxZoom,
    attribution:
      custom.attribution === undefined
        ? { en: "Custom tile provider", de: "Eigener Kachelanbieter" }
        : both(escapeHtml(custom.attribution)),
    satellite: false,
    cacheKey: `custom-${hash}`,
    ...(custom.apiKey === undefined ? {} : { apiKey: custom.apiKey }),
  };
}

/**
 * Other addresses for the built-in layers, so an install can move to a mirror or its own tile
 * server without a software update, as the providers' policies ask: `osm` and `topo` are tile
 * templates like the custom provider's, `eox` replaces the EOX WMTS base for all three EOX layers.
 */
export interface BuiltinUrls {
  readonly osm?: string | undefined;
  readonly topo?: string | undefined;
  readonly eox?: string | undefined;
}

/** Why an EOX WMTS base address is unusable, or null when it is fine. */
export function wmtsBaseProblem(base: string): string | null {
  if (/[{}]/.test(base)) return "Give the WMTS base address without placeholders.";
  return templateProblem(`${base.replace(/\/+$/, "")}/{z}/{y}/{x}`);
}

/** The built-in layers with any overridden address; a changed address gets its own cache folder. */
export function builtinLayers(urls: BuiltinUrls = {}): readonly TileLayerDef[] {
  const eox = urls.eox?.replace(/\/+$/, "");
  return BUILTIN_LAYERS.map((layer) => {
    let url = layer.url;
    if (layer.id === "osm" && urls.osm !== undefined) url = urls.osm;
    else if (layer.id === "topo" && urls.topo !== undefined) url = urls.topo;
    else if (eox !== undefined && layer.url.startsWith(EOX_WMTS)) {
      url = eox + layer.url.slice(EOX_WMTS.length);
    }
    if (url === layer.url) return layer;
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
    return { ...layer, url, cacheKey: `${layer.cacheKey}-${hash}` };
  });
}

/**
 * The allowlist the proxy serves: the built-in layers (at their configured addresses), CARTO's
 * when a CARTO key is set, and the custom one when usable.
 */
export function availableLayers(
  custom: CustomProvider | undefined,
  cartoKey?: string,
  urls?: BuiltinUrls,
): readonly TileLayerDef[] {
  const carto =
    cartoKey === undefined ? [] : CARTO_LAYERS.map((layer) => ({ ...layer, apiKey: cartoKey }));
  const extra = custom === undefined ? null : customLayer(custom);
  return [...builtinLayers(urls), ...carto, ...(extra === null ? [] : [extra])];
}

/** The upstream URL for one tile; the caller has checked the coordinates. */
export function tileUrl(layer: TileLayerDef, z: number, x: number, y: number): string {
  const subdomains = layer.subdomains ?? [];
  const values: Record<string, string> = {
    z: String(z),
    x: String(x),
    y: String(y),
    r: "",
    s: subdomains.length === 0 ? "" : (subdomains[(x + y) % subdomains.length] ?? ""),
    key: encodeURIComponent(layer.apiKey ?? ""),
  };
  return layer.url.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole);
}
