import { detectTrackingNumbers, findCarrier, loadRules } from "open-parcels-rules";
import { BUILTIN_CARRIERS } from "../engine/builtin-carriers.js";

/**
 * Old courier values that name no carrier: the old app's placeholders, aggregators it looked
 * codes up through, and the country it guessed from the code.
 */
const GENERIC_COURIERS: ReadonlySet<string> = new Set([
  "",
  "unknown",
  "other",
  "none",
  "auto",
  "china",
  "17track",
  "seventeen_track",
  "aliexpress",
]);

/** Carriers the shared rules know but no provider tracks, mapped to the provider that does. */
const TRACKED_THROUGH: Readonly<Record<string, string>> = {
  // Cainiao's global tracker covers China Post's S10 codes, which is how the old app tracked them.
  china_post: "cainiao",
  china_ems: "cainiao",
};

/** Shops whose parcels go through one logistics network when nothing else identifies the carrier. */
const SHOP_CARRIER: Readonly<Record<string, string>> = {
  aliexpress: "cainiao",
  amazon: "amazon",
};

const UNKNOWN = "unknown";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Lower-case, accent-free, words joined by `_`: the shape of every provider id. */
export function snakeCase(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

let providerIds: ReadonlySet<string> | undefined;
let providersByName: ReadonlyMap<string, string> | undefined;

function isProvider(id: string): boolean {
  providerIds ??= new Set(BUILTIN_CARRIERS.map(({ info }) => info.id));
  return providerIds.has(id);
}

/** Built-in provider ids by the snake_case of their display name, e.g. `box_now` for "BOX NOW". */
function providerIdByName(name: string): string | undefined {
  providersByName ??= new Map(
    BUILTIN_CARRIERS.map(({ info }) => [snakeCase(info.name), info.id] as const),
  );
  return providersByName.get(snakeCase(name));
}

/** A provider id for a carrier id, following carriers that are tracked through another provider. */
function trackable(id: string): string | undefined {
  const target = TRACKED_THROUGH[id] ?? id;
  return isProvider(target) ? target : undefined;
}

/**
 * The provider id for an old courier name such as "DHL", "Canada Post" or "Swiss Post": the
 * shared rules' name or alias first, then a built-in provider's display name, else snake_case.
 * Names that identify no carrier ("china", "17track") give "unknown".
 */
export function carrierId(courier: unknown): string {
  const name = text(courier);
  if (name === null || GENERIC_COURIERS.has(snakeCase(name))) {
    return UNKNOWN;
  }
  const id = findCarrier(loadRules(), name)?.id ?? providerIdByName(name) ?? snakeCase(name);
  return id === "" || GENERIC_COURIERS.has(id) ? UNKNOWN : id;
}

/** The best provider for a code by the shared tracking-number detection, as the mail watcher does. */
export function detectCarrier(trackingNumber: string, hint: string | null): string | undefined {
  const normalised = trackingNumber.replace(/\s+/g, "").toUpperCase();
  const candidates = detectTrackingNumbers(
    loadRules(),
    normalised,
    hint === null ? undefined : { carrier: hint },
  )
    .filter((candidate) => candidate.trackingNumber === normalised)
    .sort((a, b) => b.confidence - a.confidence);
  for (const candidate of candidates) {
    const id = trackable(candidate.carrier);
    if (id !== undefined) {
      return id;
    }
  }
  return undefined;
}

/** True when `next` is a provider id that should replace a stored id no provider serves. */
export function fixesCarrier(stored: string, next: string): boolean {
  return stored !== next && !isProvider(stored) && isProvider(next);
}

export interface LegacyCarrierInput {
  /** The old `courier` column, possibly empty or generic. */
  readonly courier: unknown;
  readonly trackingNumber: string;
  /** The old order's `connection` (shop), when the parcel belonged to one. */
  readonly shop: string | null;
}

/**
 * Resolves an old parcel to a provider id, in order: the named courier when a provider tracks it;
 * the code's format by the shared detection (with the named courier as a hint); the shop's own
 * network (AliExpress → Cainiao, Amazon → Amazon); a named carrier no provider tracks yet, kept so a
 * later provider picks it up; otherwise "unknown".
 */
export function resolveLegacyCarrier(input: LegacyCarrierInput): string {
  const named = carrierId(input.courier);
  const namedProvider = named === UNKNOWN ? undefined : trackable(named);
  if (namedProvider !== undefined) {
    return namedProvider;
  }
  const detected = detectCarrier(
    input.trackingNumber,
    named === UNKNOWN ? null : text(input.courier),
  );
  if (detected !== undefined) {
    return detected;
  }
  const shop = input.shop === null ? undefined : SHOP_CARRIER[snakeCase(input.shop)];
  if (shop !== undefined) {
    return shop;
  }
  // "china" names a country, not a carrier, but the old app used it for Chinese postal codes.
  if (snakeCase(text(input.courier) ?? "") === "china") {
    return trackable("china_post") ?? UNKNOWN;
  }
  return named;
}
