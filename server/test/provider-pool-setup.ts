/**
 * Global setup of the `providers-pool` test project: bundles the provider guest as the image does
 * (one ESM file with every dependency inside, the rules' bundle and `package.json` where the
 * bundled code reads them) into a temporary folder, and hands its location to the tests, whose
 * `registerBuiltin` then serves every built-in provider from a sandbox child.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** The bundled provider guest's folder; set only in the `providers-pool` project. */
    providerGuest?: string;
  }
}

const SERVER = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export default async function setup(project: TestProject): Promise<() => void> {
  const root = mkdtempSync(path.join(tmpdir(), "open-parcels-guest-"));
  const guestDir = path.join(root, "dist");
  await build({
    entryPoints: [path.join(SERVER, "src", "sandbox", "provider-guest.ts")],
    outfile: path.join(guestDir, "provider-guest.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    banner: {
      js: "import { createRequire as __openParcelsRequire } from 'node:module'; const require = __openParcelsRequire(import.meta.url);",
    },
    logLevel: "warning",
  });
  const resolver = createRequire(path.join(SERVER, "package.json"));
  cpSync(resolver.resolve("open-parcels-rules/bundle.json"), path.join(guestDir, "bundle.json"));
  cpSync(path.join(SERVER, "package.json"), path.join(root, "package.json"));
  project.provide("providerGuest", root);
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
