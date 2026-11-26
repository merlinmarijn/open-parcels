/**
 * Manifests in tests: built-in carriers register with the manifest in their folder (as the server
 * does), made-up carriers with one built here.
 */
import { BUILTIN_CARRIERS } from "../src/engine/builtin-carriers.js";
import { register, type RegisteredProvider } from "../src/engine/registry.js";
import type { CarrierProvider } from "../src/provider/api.js";
import type { HostAllowList, ProviderManifest } from "../src/provider/manifest.js";

/** The manifest of the built-in provider `id`. */
export function builtinManifest(id: string): ProviderManifest {
  const found = BUILTIN_CARRIERS.find((provider) => provider.info.id === id);
  if (found === undefined) {
    throw new Error(`${id} is not a built-in provider.`);
  }
  return found.manifest;
}

/** Registers a built-in carrier's code with its own manifest. */
export function registerBuiltin<Config, Secret>(
  carrier: CarrierProvider<Config, Secret>,
): RegisteredProvider {
  return register(carrier, builtinManifest(carrier.id));
}

/** A manifest for a made-up carrier: tracking only, no network, unless `changes` says otherwise. */
export function testManifest(
  id: string,
  changes: {
    readonly name?: string;
    readonly countries?: readonly string[];
    readonly provides?: Partial<ProviderManifest["provides"]>;
    readonly permissions?: Partial<ProviderManifest["permissions"]>;
  } = {},
): ProviderManifest {
  return {
    schema: 1,
    id,
    name: changes.name ?? id,
    countries: [...(changes.countries ?? ["*"])],
    provides: { connections: ["tracking"], live: false, fallback: false, ...changes.provides },
    permissions: {
      network: [],
      image_hosts: [],
      secrets: [],
      session: false,
      user_agent: false,
      ...changes.permissions,
    },
  };
}

/** Every host: for tests of the HTTP client itself, which are not about a provider's manifest. */
export const ANY_HOST: HostAllowList = { allows: () => true };
