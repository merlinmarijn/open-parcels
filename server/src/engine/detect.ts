import { detectTrackingNumbers, loadRules } from "open-parcels-rules";
import { BUILTIN_CARRIERS } from "./builtin-carriers.js";

/** Carriers the shared rules know but no provider tracks, mapped to the provider that does. */
const TRACKED_THROUGH: Readonly<Record<string, string>> = {
  // Cainiao's global tracker covers China Post's S10 codes, which is how the old app tracked them.
  china_post: "cainiao",
  china_ems: "cainiao",
};

let providerIds: ReadonlySet<string> | undefined;

/** True for the id of a built-in provider. */
export function isProvider(id: string): boolean {
  providerIds ??= new Set(BUILTIN_CARRIERS.map(({ info }) => info.id));
  return providerIds.has(id);
}

/** A provider id for a carrier id, following carriers that are tracked through another provider. */
export function trackable(id: string): string | undefined {
  const target = TRACKED_THROUGH[id] ?? id;
  return isProvider(target) ? target : undefined;
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
