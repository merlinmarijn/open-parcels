/**
 * Manifests in tests: built-in carriers register with the manifest in their folder (as the server
 * does), made-up carriers with one built here.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inject } from "vitest";
import { systemClock } from "../src/clock.js";
import { BUILTIN_CARRIERS } from "../src/engine/builtin-carriers.js";
import { register, type RegisteredProvider } from "../src/engine/registry.js";
import { Sandbox } from "../src/sandbox/host.js";
import { rebuildProviderError } from "../src/sandbox/provider-wire.js";
import { isolated } from "../src/sandbox/providers.js";
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

let pool: Sandbox | undefined;

/** The sandbox of this test file's providers, in the `providers-pool` project. */
function testPool(guestRoot: string): Sandbox {
  pool ??= new Sandbox({
    child: new URL("../src/sandbox/child.ts", import.meta.url),
    guest: pathToFileURL(path.join(guestRoot, "dist", "provider-guest.js")),
    readable: [guestRoot],
    memoryMb: 256,
    clock: systemClock,
    rebuildError: rebuildProviderError,
  });
  return pool;
}

/** Stops this test file's provider sandbox (the `providers-pool` project's setup file). */
export function stopTestPool(): void {
  pool?.stop();
  pool = undefined;
}

/**
 * Registers a built-in carrier's code with its own manifest. In the `providers-pool` project its
 * behaviour is served from a sandbox child running the bundled built-ins, so the same suites cover
 * both isolation modes.
 */
export function registerBuiltin<Config, Secret>(
  carrier: CarrierProvider<Config, Secret>,
): RegisteredProvider {
  const registered = register(carrier, builtinManifest(carrier.id));
  const guestRoot = inject("providerGuest");
  return guestRoot === undefined ? registered : isolated(registered, testPool(guestRoot));
}

/** A manifest for a made-up carrier: tracking only, no network, unless `changes` says otherwise. */
export function testManifest(
  id: string,
  changes: {
    readonly name?: string;
    readonly countries?: readonly string[];
    readonly provides?: Partial<ProviderManifest["provides"]>;
    readonly permissions?: Partial<ProviderManifest["permissions"]>;
    readonly actions?: ProviderManifest["actions"];
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
    actions: [...(changes.actions ?? [])],
  };
}

/** Every host: for tests of the HTTP client itself, which are not about a provider's manifest. */
export const ANY_HOST: HostAllowList = { allows: () => true };
